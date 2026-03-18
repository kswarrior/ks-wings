/**
 * @fileoverview Handles container power management actions via Docker.
 */

const express = require("express");
const router = express.Router();
const Docker = require("../utils/Docker");
const fs = require("fs");
const path = require("path");
const { calculateDirectorySize } = require("../utils/FileType");

const docker = new Docker({ socketPath: process.env.dockerSocket });

/**
 * Reads the disk limit and volume ID association from states.json
 */
function getStateForContainer(containerId) {
  const statesFilePath = path.join(__dirname, "../storage/states.json");
  try {
    if (fs.existsSync(statesFilePath)) {
      const statesData = JSON.parse(fs.readFileSync(statesFilePath, "utf8"));
      for (const [volumeId, state] of Object.entries(statesData)) {
        if (state.containerId === containerId) {
          return { volumeId, ...state };
        }
      }
    }
  } catch (err) {
    console.warn("Failed to read states:", err.message);
  }
  return null;
}

// ====================== NEW: Auto-run template start code ======================
async function runStartCode(container, startCode) {
  if (!startCode || typeof startCode !== "string" || startCode.trim() === "") {
    return;
  }
  try {
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", startCode],
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
    });
    await exec.start({ hijack: false, stdin: false });
    console.log(`[KS Wings] Start code executed successfully inside container`);
  } catch (err) {
    console.error(`[KS Wings] Failed to run start code:`, err.message);
  }
}

// ====================== NEW: Graceful stop (e.g. "stop" command for Minecraft) ======================
async function runStopCode(container, command) {
  if (!command || typeof command !== "string") return;
  try {
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    await exec.start({ hijack: false, stdin: false });
    console.log(`[KS Wings] Stop command executed: ${command}`);
  } catch (err) {
    console.error(`[KS Wings] Run stop code failed:`, err.message);
  }
}

// ====================== MAIN POWER ROUTE ======================
router.post("/instances/:id/:power", async (req, res) => {
  const { power } = req.params;
  const containerId = req.params.id;
  const container = docker.getContainer(containerId);

  try {
    // Disk limit check (original behaviour)
    if (power === "start" || power === "restart") {
      const state = getStateForContainer(containerId);
      if (state && state.diskLimit && state.diskLimit > 0) {
        const volumePath = path.join(__dirname, "../volumes", state.volumeId);
        try {
          const currentSize = await calculateDirectorySize(volumePath);
          const currentSizeMiB = currentSize / (1024 * 1024);
          if (currentSizeMiB >= state.diskLimit) {
            return res.status(403).json({
              message: "Cannot start server: storage limit exceeded. Please delete some files or increase your disk limit.",
              currentUsageMiB: Math.round(currentSizeMiB),
              limitMiB: state.diskLimit
            });
          }
        } catch (sizeErr) {
          console.warn("Could not calculate volume size:", sizeErr.message);
        }
      }
    }

    switch (power) {
      case "start":
      case "restart":
        await container[power]();
        // Automatically run the start code from your template
        const startCode = req.body.startCode || "";
        await runStartCode(container, startCode);
        res.status(200).json({ message: `Container ${power}ed successfully` });
        break;

      case "stop":
        const stopCommand = req.body.command || "";
        if (stopCommand) {
          await runStopCode(container, stopCommand);
          res.status(200).json({ message: "Stop command sent successfully" });
        } else {
          await container.stop();
          res.status(200).json({ message: `Container stopped successfully` });
        }
        break;

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
      res.status(304).json({ message: err.message });
    } else {
      console.error("Power action failed:", err.message);
      res.status(500).json({ message: err.message });
    }
  }
});

module.exports = router;
