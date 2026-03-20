const express = require("express");
const router = express.Router();
const Docker = require("../utils/Docker");
const docker = new Docker({ socketPath: process.env.dockerSocket });
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { calculateDirectorySize } = require("../utils/FileType");
const CatLoggr = require("cat-loggr");
const log = new CatLoggr();

const statesFilePath = path.join(__dirname, "../storage/states.json");

// ==================== READ STATES ====================
function getStateForContainer(containerId) {
  try {
    if (fsSync.existsSync(statesFilePath)) {
      const statesData = JSON.parse(fsSync.readFileSync(statesFilePath, "utf8"));
      for (const [volumeId, state] of Object.entries(statesData)) {
        if (state.containerId === containerId) {
          return { volumeId, ...state };
        }
      }
    }
  } catch (err) {
    log.warn("Failed to read states.json:", err.message);
  }
  return null;
}

// ==================== AUTO-RUN TEMPLATE START CODE ====================
const runStartCode = async (container, startCode) => {
  if (!startCode || typeof startCode !== "string" || startCode.trim() === "") return;
  try {
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", startCode],
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      WorkingDir: "/data"
    });
    await exec.start({ Detach: true, Tty: false });
    log.info(`[KS Wings] Template start code executed successfully in /data`);
  } catch (err) {
    log.error(`[KS Wings] Failed to run start code:`, err.message);
  }
};

// ==================== GRACEFUL STOP COMMAND ====================
const runStopCode = async (container, command) => {
  if (!command || typeof command !== "string" || command.trim() === "") return;
  try {
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", command],
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      WorkingDir: "/data"
    });
    await exec.start({ Detach: true, Tty: false });
    log.info(`[KS Wings] Stop command executed: ${command}`);
  } catch (err) {
    log.error(`[KS Wings] Stop command failed:`, err.message);
  }
};

// ==================== MAIN POWER ROUTE ====================
router.post("/instances/:id/:power", async (req, res) => {
  const containerId = req.params.id;
  const power = req.params.power;
  const container = docker.getContainer(containerId);

  try {
    if (power === "start" || power === "restart") {
      const state = getStateForContainer(containerId);
      if (state && state.diskLimit && state.diskLimit > 0) {
        const volumePath = path.join(__dirname, "../volumes", state.volumeId);
        const currentSize = await calculateDirectorySize(volumePath);
        const currentSizeMiB = currentSize / (1024 * 1024);
        if (currentSizeMiB >= state.diskLimit) {
          return res.status(403).json({
            message: "Cannot start: storage limit exceeded.",
            currentUsageMiB: Math.round(currentSizeMiB),
            limitMiB: state.diskLimit
          });
        }
      }
    }

    switch (power) {
      case "start":
      case "restart":
        await container[power]();

        // ==================== BULLETPROOF RACE CONDITION FIX (60s + REAL SKIP) ====================
        // Waits up to 60 seconds. Only runs startCode if container is truly running.
        // If timeout → skip startCode (prevents 409 forever) + only warn log.
        let attempts = 0;
        const maxAttempts = 120; // 120 × 500ms = 60 seconds
        let isRunning = false;
        while (attempts < maxAttempts) {
          try {
            const info = await container.inspect();
            if (info && info.State && (info.State.Running === true || info.State.Status === "running")) {
              isRunning = true;
              break;
            }
          } catch (inspectErr) {
            // Ignore temporary inspect errors during startup
          }
          await new Promise(r => setTimeout(r, 500));
          attempts++;
        }
        if (!isRunning) {
          log.warn(`[KS Wings] Container ${containerId} did not reach running state in 60s - skipping startCode`);
        }
        // ==================== END OF FIX ====================

        // ONLY run startCode if container is actually running
        if (isRunning) {
          const startCode = req.body.startCode || "";
          await runStartCode(container, startCode);
        }

        res.json({ message: `Container ${power}ed` + (isRunning ? " + template code executed" : " (startCode skipped)") });
        break;

      case "stop":
        const stopCommand = req.body.command || "";
        if (stopCommand && stopCommand.trim() !== "") {
          await runStopCode(container, stopCommand);
        }
        await container.stop({ t: 10 });
        res.json({ message: "Container stopped successfully" });
        break;

      default:
        res.status(400).json({ message: "Invalid power action" });
    }
  } catch (err) {
    log.error("Power action failed:", err.message);
    if (err.statusCode === 304) {
      res.status(304).json({ message: err.message });
    } else {
      res.status(500).json({ message: err.message });
    }
  }
});

// Legacy /runcode
router.post("/instances/:id/runcode", async (req, res) => {
  const containerId = req.params.id;
  const command = req.body.command;
  const container = docker.getContainer(containerId);

  try {
    await runStopCode(container, command);
    res.json({ message: "Command executed successfully inside container" });
  } catch (err) {
    log.error("Runcode failed:", err.message);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
