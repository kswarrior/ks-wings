const express = require("express");
const router = express.Router();
const Docker = require("../utils/Docker");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const CatLoggr = require("cat-loggr");
const log = new CatLoggr();
const https = require("https");
const { pipeline } = require("stream/promises");

const docker = new Docker({ socketPath: process.env.dockerSocket });

const statesFilePath = path.join(__dirname, "../storage/states.json");

const readStates = async () => {
  try {
    if (!fsSync.existsSync(statesFilePath)) {
      await fs.writeFile(statesFilePath, JSON.stringify({}, null, 2));
    }
    const data = await fs.readFile(statesFilePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
};

const writeStates = async (states) => {
  if (!fsSync.existsSync(statesFilePath)) {
    await fs.writeFile(statesFilePath, JSON.stringify({}, null, 2));
  }
  await fs.writeFile(statesFilePath, JSON.stringify(states, null, 2));
};

const updateState = async (volumeId, state, containerId = null, diskLimit = null) => {
  const states = await readStates();
  states[volumeId] = { state, containerId, diskLimit };
  await writeStates(states);
};

const downloadFile = async (url, dir, filename) => {
  const filePath = path.join(dir, filename);
  const writeStream = fsSync.createWriteStream(filePath);
  const maxAttempts = 3;
  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      attempt++;
      const response = await new Promise((resolve, reject) => {
        https.get(url, (res) => resolve(res)).on("error", reject);
      });

      if (response.statusCode === 522) {
        log.info(`Received status code 522. Waiting for 60 seconds before retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 60000));
        continue;
      }

      if (response.statusCode !== 200) {
        throw new Error(`Failed to download ${filename}: HTTP status code ${response.statusCode} on the URL ${url}`);
      }

      await pipeline(response, writeStream);
      log.info(`Downloaded ${filename} successfully.`);
      break;
    } catch (err) {
      log.error(`Attempt ${attempt} failed: ${err.message}`);
      await fsSync.promises.unlink(filePath).catch(() => {});
      if (attempt === maxAttempts) {
        throw new Error(`Failed to download ${filename} after ${maxAttempts} attempts.`);
      }
    }
  }
};

const downloadInstallScripts = async (installScripts, dir, variables) => {
  const parsedVariables = typeof variables === "string" ? JSON.parse(variables) : variables;

  for (const script of installScripts) {
    try {
      let updatedUri = script.Uri;
      for (const [key, value] of Object.entries(parsedVariables)) {
        const regex = new RegExp(`{{${key}}}`, "g");
        updatedUri = updatedUri.replace(regex, value);
        log.info(updatedUri);
      }
      await downloadFile(updatedUri, dir, script.Path);
      log.info(`Successfully downloaded ${script.Path}`);
    } catch (err) {
      log.error(`Failed to download ${script.Path}: ${err.message}`);
    }
  }
};

const replaceVariables = async (dir, variables) => {
  const files = await fs.readdir(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stats = await fs.stat(filePath);
    if (stats.isFile() && !file.endsWith(".jar")) {
      let content = await fs.readFile(filePath, "utf8");
      for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`{{${key}}}`, "g");
        content = content.replace(regex, value);
      }
      await fs.writeFile(filePath, content, "utf8");
      log.info(`Variables replaced in ${file}`);
    }
  }
};

const objectToEnv = (obj) => Object.entries(obj).map(([key, value]) => `${key}=${value}`);

const createContainerOptions = (config, volumePath) => ({
  name: config.Id,
  Image: config.Image,
  ExposedPorts: config.Ports,
  AttachStdout: true,
  AttachStderr: true,
  AttachStdin: true,
  Tty: true,
  OpenStdin: true,
  HostConfig: {
    PortBindings: config.PortBindings,
    Binds: [`${volumePath}:/app/data`],
    Memory: config.Memory * 1024 * 1024,
    CpuCount: config.Cpu,
    NetworkMode: process.platform === "win32" ? "bridge" : "host",
  },
  Env: config.Env,
  ...(config.Cmd && { Cmd: config.Cmd }),
});

const createContainer = async (req, res) => {
  log.info("Deployment in progress...");
  let { Image, Id, Cmd, Env, Ports, ExposedPorts, Scripts, Memory, Cpu, Disk, PortBindings, variables } = req.body;

  let parsedVariables = variables || {};
  if (typeof variables !== "string") {
    variables = JSON.stringify(variables);
  } else {
    try {
      JSON.parse(variables);
    } catch (e) {
      variables = JSON.stringify(variables);
    }
  }

  try {
    const volumePath = path.join(__dirname, "../volumes", Id);
    await fs.mkdir(volumePath, { recursive: true });
    const primaryPort = Object.values(PortBindings)[0][0].HostPort;

    const variablesEnv = variables && Object.keys(parsedVariables).length > 0 ? objectToEnv(parsedVariables) : [];

    const environmentVariables = [...(Env || []), ...variablesEnv, `PRIMARY_PORT=${primaryPort}`];

    await updateState(Id, "INSTALLING", null, Disk || 0);

    log.info(`Pulling image: ${Image}`);
    try {
      const stream = await docker.pull(Image);
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, result) => {
          if (err) return reject(new Error(`Failed to pull image: ${err.message}`));
          log.info(`Image ${Image} pulled successfully.`);
          resolve(result);
        });
      });
    } catch (err) {
      log.error(`Error pulling image ${Image}:`, err);
      return res.status(500).json({ message: err.message });
    }

    const containerOptions = createContainerOptions(
      {
        Image,
        Id,
        Cmd,
        Ports: ExposedPorts || Ports,   // ← minimal fix for panel → wings compatibility
        Memory,
        Cpu,
        PortBindings,
        Env: environmentVariables,
      },
      volumePath
    );

    const container = await docker.createContainer(containerOptions);
    log.info("Container created: " + container.id);

    // Respond immediately (moved after createContainer so we can send containerId)
    res.status(202).json({
      message: "Deployment started",
      Env: environmentVariables,
      volumeId: Id,
      containerId: container.id,   // ← critical for panel
    });

    if (Scripts && Scripts.Install && Array.isArray(Scripts.Install)) {
      const dir = path.join(__dirname, "../volumes", Id);
      await downloadInstallScripts(Scripts.Install, dir, variables || {});

      const replaceVars = {
        primaryPort: primaryPort,
        containerName: container.id.substring(0, 12),
        timestamp: new Date().toISOString(),
        randomString: Math.random().toString(36).substring(7),
      };

      await replaceVariables(dir, replaceVars);
    }

    await container.start();

    await updateState(Id, "READY", container.id, Disk || 0);
    log.info("Deployment completed successfully");
  } catch (err) {
    log.error("Deployment failed: " + err.message);
    await updateState(Id, "FAILED", null, Disk || 0);
    if (!res.headersSent) {
      res.status(500).json({ message: err.message });
    }
  }
};

// === Other routes unchanged ===
const deleteContainer = async (req, res) => { /* original code unchanged */ };
const redeployContainer = async (req, res) => { /* original code unchanged */ };
const reinstallContainer = async (req, res) => { /* original code unchanged */ };
const editContainer = async (req, res) => { /* original code unchanged */ };
const getContainerState = async (req, res) => { /* original code unchanged */ };

router.post("/instances/create", createContainer);
router.delete("/instances/:id", deleteContainer);
router.post("/instances/redeploy/:id/:Idd", redeployContainer);
router.post("/instances/reinstall/:id/:Idd", reinstallContainer);
router.put("/instances/edit/:id", editContainer);
router.get("/state/:volumeId", getContainerState);

module.exports = router;
