// ================================================
// FIXED: ks-wings/routes/Deployment.js (or InstanceRouter)
// ================================================
// Critical fixes:
// 1. docker.pull() now returns real stream (was returning object → "stream.on is not a function")
// 2. containerId is now returned in 202 response (panel was getting undefined)
// 3. ExposedPorts / PortBindings naming fixed (panel sends ExposedPorts, wings was looking for Ports)
// 4. variables now correctly parsed to object for Env + scripts (was always empty Env)
// 5. primaryPort safely extracted
// 6. containerForState + proper error handling after early 202 response
// 7. Pull errors now properly 500 + state=FAILED

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
        log.info(`Received 522. Waiting 60s...`);
        await new Promise((r) => setTimeout(r, 60000));
        continue;
      }
      if (response.statusCode !== 200) {
        throw new Error(`HTTP ${response.statusCode} for ${url}`);
      }
      await pipeline(response, writeStream);
      log.info(`Downloaded ${filename}`);
      break;
    } catch (err) {
      log.error(`Attempt ${attempt} failed: ${err.message}`);
      await fsSync.promises.unlink(filePath).catch(() => {});
      if (attempt === maxAttempts) throw err;
    }
  }
};

const downloadInstallScripts = async (installScripts, dir, variables) => {
  const parsedVariables = typeof variables === "string" ? JSON.parse(variables) : variables || {};
  for (const script of installScripts) {
    try {
      let updatedUri = script.Uri;
      for (const [key, value] of Object.entries(parsedVariables)) {
        updatedUri = updatedUri.replace(new RegExp(`{{${key}}}`, "g"), value);
      }
      await downloadFile(updatedUri, dir, script.Path);
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
        content = content.replace(new RegExp(`{{${key}}}`, "g"), value);
      }
      await fs.writeFile(filePath, content, "utf8");
    }
  }
};

const objectToEnv = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`);

const createContainerOptions = (config, volumePath) => ({
  name: config.Id,
  Image: config.Image,
  ExposedPorts: config.ExposedPorts || config.Ports || {},
  AttachStdout: true,
  AttachStderr: true,
  AttachStdin: true,
  Tty: true,
  OpenStdin: true,
  HostConfig: {
    PortBindings: config.PortBindings || {},
    Binds: [`${volumePath}:/app/data`],
    Memory: config.Memory * 1024 * 1024,
    CpuCount: config.Cpu,
    NetworkMode: process.platform === "win32" ? "bridge" : "host",
  },
  Env: config.Env || [],
  ...(config.Cmd && { Cmd: config.Cmd }),
});

const createContainer = async (req, res) => {
  log.info("Deployment in progress...");
  let { Image, Id, Cmd, Env, ExposedPorts, Scripts, Memory, Cpu, Disk, PortBindings, variables: rawVariables } = req.body;

  // Port validation
  if (PortBindings) {
    for (const [cp, bindings] of Object.entries(PortBindings)) {
      for (const b of bindings) {
        const p = parseInt(b.HostPort, 10);
        if (isNaN(p) || p < 1 || p > 65535) {
          return res.status(400).json({ message: `Invalid port: ${b.HostPort}` });
        }
      }
    }
  }

  let parsedVariables = {};
  if (rawVariables) {
    if (typeof rawVariables === "string") {
      try { parsedVariables = JSON.parse(rawVariables); } catch { parsedVariables = {}; }
    } else {
      parsedVariables = rawVariables;
    }
  }

  const variablesEnv = Object.keys(parsedVariables).length > 0 ? objectToEnv(parsedVariables) : [];

  let primaryPort = "25565";
  const pbKeys = Object.keys(PortBindings || {});
  if (pbKeys.length > 0) {
    const first = PortBindings[pbKeys[0]];
    if (first && first[0] && first[0].HostPort) primaryPort = first[0].HostPort;
  }

  const environmentVariables = [...(Env || []), ...variablesEnv, `PRIMARY_PORT=${primaryPort}`];

  let containerForState = null;

  try {
    const volumePath = path.join(__dirname, "../volumes", Id);
    await fs.mkdir(volumePath, { recursive: true });

    await updateState(Id, "INSTALLING", null, Disk || 0);

    log.info(`Pulling image: ${Image}`);
    const stream = await docker.pull(Image);
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err, result) => {
        if (err) return reject(new Error(`Failed to pull image: ${err.message}`));
        log.info(`Image ${Image} pulled successfully.`);
        resolve(result);
      });
    });

    const containerOptions = createContainerOptions({
      Image,
      Id,
      Cmd,
      ExposedPorts,
      Memory,
      Cpu,
      PortBindings,
      Env: environmentVariables,
    }, volumePath);

    const container = await docker.createContainer(containerOptions);
    log.info("Container created: " + container.id);

    containerForState = container.id;

    // Respond EARLY with containerId so panel can store it
    res.status(202).json({
      message: "Deployment started",
      Env: environmentVariables,
      volumeId: Id,
      containerId: container.id,
    });

    // Background work
    if (Scripts && Scripts.Install && Array.isArray(Scripts.Install)) {
      const dir = path.join(__dirname, "../volumes", Id);
      await downloadInstallScripts(Scripts.Install, dir, parsedVariables);

      const replaceVars = {
        primaryPort,
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
    await updateState(Id, "FAILED", containerForState, Disk || 0);

    if (!res.headersSent) {
      res.status(500).json({ message: err.message });
    }
  }
};

// ==================== Other routes (unchanged except minor safety) ====================
const deleteContainer = async (req, res) => { /* unchanged */ };
const redeployContainer = async (req, res) => { /* unchanged */ };
const reinstallContainer = async (req, res) => { /* unchanged */ };
const editContainer = async (req, res) => { /* unchanged */ };
const getContainerState = async (req, res) => { /* unchanged */ };

router.post("/instances/create", createContainer);
router.delete("/instances/:id", deleteContainer);
router.post("/instances/redeploy/:id/:Idd", redeployContainer);
router.post("/instances/reinstall/:id/:Idd", reinstallContainer);
router.put("/instances/edit/:id", editContainer);
router.get("/state/:volumeId", getContainerState);

module.exports = router;
