/**
 * @fileoverview Handles container power management actions via Docker.
 * Supports start/stop/restart/pause/unpause/kill + graceful console command execution
 * for Minecraft/Paper servers via /runcode endpoint.
 */

const express = require("express");
const router = express.Router();
const Docker = require("../utils/Docker");
const fs = require("fs");
const path = require("path");
const { calculateDirectorySize } = require("../utils/FileType");

const docker = new Docker({ socketPath: process.env.dockerSocket });

const log = new (require("cat-loggr"))();

/**
 * Reads the disk limit and volume ID association from states.json
 * @param {string} containerId 
 * @returns {Object|null}
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
    console.warn("Failed to read states.json:", err.message);
  }
  return null;
}

/**
 * POST /instances/:id/runcode
 * Sends a command to the container's stdin (used by panel for "stop")
 * MUST be defined BEFORE the :power route
 */
router.post("/instances/:id/runcode", async (req, res) => {
  const { id } = req.params;
  const { command } = req.body;

  if (!command || typeof command !== "string" || command.trim() === "") {
    return res.status(400).json({ error: "Valid 'command' string is required" });
  }

  const container = docker.getContainer(id);

  try {
    // Check if container is running
    const inspect = await container.inspect();
    if (!inspect.State.Running) {
      return res.status(409).json({ error: "Container is not running" });
    }

    // Send command to PID 1 stdin via /proc/1/fd/0
    const exec = await container.exec({
      Cmd: ["sh", "-c", `echo "${command.replace(/"/g, '\\"')}" > /proc/1/fd/0`],
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
    });

    await exec.start();
    log.info(`[Wings] Console command sent to ${id}: ${command}`);

    res.status(200).json({
      message: `Command "${command}" sent to container console`,
      command: command
    });
  } catch (err) {
    log.error(`[Wings] Failed to send command "${command}" to ${id}:`, err.message);

    // Fallback: force stop after timeout
    try {
      await container.stop({ t: 10 });
      res.status(200).json({
        message: `Command send failed → forced container stop after 10s grace`,
        fallback: "stop"
      });
    } catch (stopErr) {
      res.status(500).json({
        error: "Failed to send command and fallback stop also failed",
        details: stopErr.message
      });
    }
  }
});

/**
 * POST /instances/:id/:power
 * Standard Docker power actions with disk limit check
 */
router.post("/instances/:id/:power", async (req, res) => {
  const { power } = req.params;
  const containerId = req.params.id;
  const container = docker.getContainer(containerId);

  try {
    // Disk limit check before starting or restarting
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
      case "stop":
      case "restart":
      case "pause":
      case "unpause":
      case "kill":
        await container[power]();
        res.status(200).json({ 
          message: `Container ${power}ed successfully`,
          action: power 
        });
        break;

      default:
        res.status(400).json({ message: "Invalid power action" });
    }
  } catch (err) {
    if (err.statusCode === 304) {
      res.status(304).json({ message: err.message || "Container already in desired state" });
    } else {
      log.error(`Power action failed (${power} on ${containerId}):`, err.message);
      res.status(500).json({ 
        message: "Failed to perform power action",
        error: err.message 
      });
    }
  }
});

module.exports = router;
