const express = require("express");
const router = express.Router();
const Docker = require("../utils/Docker");
const docker = new Docker({ socketPath: process.env.dockerSocket });
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const util = require("util");
const execAsync = util.promisify(require("child_process").exec);

const statesFilePath = path.join(__dirname, "../storage/states.json");

const readStates = async () => {
  try {
    if (!fsSync.existsSync(statesFilePath)) {
      await fs.writeFile(statesFilePath, JSON.stringify({}, null, 2));
    }
    const data = await fs.readFile(statesFilePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
};

const getStateForContainer = async (containerId) => {
  const states = await readStates();
  for (const volumeId in states) {
    if (states[volumeId].containerId === containerId) {
      return states[volumeId];
    }
  }
  return null;
};

const calculateDirectorySize = async (dirPath) => {
  try {
    const { stdout } = await execAsync(`du -sb "${dirPath}"`);
    return parseInt(stdout.trim().split("\t")[0]);
  } catch (e) {
    return 0;
  }
};

// === YOUR EXISTING ROUTES (unchanged except now they work) ===
router.post("/instances/:id/runcode", async (req, res) => { ... }); // keep exactly as you have

router.post("/instances/:id/:power", async (req, res) => {
  const { power } = req.params;
  const containerId = req.params.id;
  const container = docker.getContainer(containerId);

  try {
    // Disk limit check (now works)
    if (power === "start" || power === "restart") {
      const state = await getStateForContainer(containerId);
      if (state && state.diskLimit && state.diskLimit > 0) {
        const volumePath = path.join(__dirname, "../volumes", state.volumeId || "");
        const currentSize = await calculateDirectorySize(volumePath);
        const currentSizeMiB = currentSize / (1024 * 1024);

        if (currentSizeMiB >= state.diskLimit) {
          return res.status(403).json({
            message: "Cannot start server: storage limit exceeded...",
            currentUsageMiB: Math.round(currentSizeMiB),
            limitMiB: state.diskLimit
          });
        }
      }
    }

    switch (power) {
      case "start":
      case "stop":
      case "restart":
      case "pause":
      case "unpause":
      case "kill":
        await container[power]();
        res.status(200).json({ message: `Container ${power}ed successfully` });
        break;
      default:
        res.status(400).json({ message: "Invalid power action" });
    }
  } catch (err) {
    if (err.statusCode === 304) {
      return res.status(304).json({ message: "Already in desired state" });
    }
    log.error(`Power action failed (${power}):`, err.message);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
