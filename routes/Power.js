const express = require("express");
const router = express.Router();
const Docker = require("../utils/Docker");
const docker = new Docker({ socketPath: process.env.dockerSocket });
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const util = require("util");
const execAsync = util.promisify(require("child_process").exec);

const CatLoggr = require("cat-loggr");
const log = new CatLoggr();

const statesFilePath = path.join(__dirname, "../storage/states.json");

// ... (keep your readStates, getStateForContainer, calculateDirectorySize exactly as-is)

// NEW: Run the start code INSIDE the container (your fix)
const runStartCode = async (container, startCode) => {
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
    log.info(`Start code executed successfully inside container`);
  } catch (err) {
    log.error(`Failed to run start code:`, err.message);
  }
};

// NEW: Graceful runcode for stop (MC "stop" command etc.)
const runCode = async (container, command) => {
  if (!command || typeof command !== "string") return;
  try {
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: false, stdin: false });
    log.info(`Runcode executed: ${command}`);
  } catch (err) {
    log.error(`Runcode failed:`, err.message);
  }
};

router.post("/instances/:id/:power", async (req, res) => { ... // keep your existing start/restart/stop logic exactly
  // (your disk check + switch with runStartCode for start/restart)
});

router.post("/instances/:id/runcode", async (req, res) => {  // ← NEW endpoint for stop
  const containerId = req.params.id;
  const command = req.body.command;
  const container = docker.getContainer(containerId);

  try {
    await runCode(container, command);
    res.status(200).json({ message: "Command executed successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
