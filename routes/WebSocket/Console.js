const fs = require("node:fs");
const path = require("path");
const CatLoggr = require("cat-loggr");
const log = new CatLoggr();
const statsHandler = require("./Stats.js");

// ==============================================
// RAW LOG STREAM - Exactly like docker logs -f
// ==============================================
async function streamDockerLogs(ws, container) {
  const containerId = container.id;

  // Prevent duplicate streams (this was causing logs to show double)
  if (ws.logStream) {
    log.info(`[kswings] Log stream already active for this WebSocket – skipping duplicate setup`);
    return;
  }

  try {
    // IMPORTANT: NO tail → Docker returns FULL history + live follow
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      // tail removed = all logs (same as docker logs -f)
    });

    if (!logStream) {
      throw new Error("Log stream is undefined");
    }

    logStream.on("data", (chunk) => {
      // Strip Docker's 8-byte multiplex header (stdout/stderr)
      const content = chunk.length > 8
        ? chunk.slice(8).toString("utf8")
        : chunk.toString("utf8");

      // === FIXED: Remove ALL "X INFO]:" prefixes (0 INFO], 6 INFO], 7 INFO], etc.) ===
      // This matches any number followed by " INFO]:" (with or without colon/spaces)
      // Exactly what PaperMC is outputting in your container.
      const cleanContent = content.replace(/\d+\s+INFO\]:?\s*/g, "");

      // RAW output - now completely clean (exactly what you wanted)
      if (ws.readyState === ws.OPEN && ws.bufferedAmount === 0) {
        ws.send(cleanContent);
      }
    });

    logStream.on("error", (err) => {
      log.error(`Docker log stream error: ${err.message}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n\u001b[31m[kswings] \x1b[0mLog stream error: ${err.message}\r\n`);
      }
    });

    // Clean close handler
    ws.on("close", () => {
      try {
        if (ws.logStream) {
          ws.logStream.destroy();
          delete ws.logStream;
        }
      } catch (_) {}
      log.info("WebSocket client disconnected from logs");
    });

    // Store the stream so we can detect duplicates and clean up on close
    ws.logStream = logStream;

  } catch (err) {
    log.error(`Failed to attach Docker logs: ${err.message}`);
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\u001b[31m[kswings] \x1b[0mFailed to attach logs: ${err.message}\r\n`);
    }
  }
}

// ==============================================
// EXEC COMMAND (unchanged - works perfectly)
// ==============================================
async function executeCommand(ws, container, command) {
  try {
    const exec = await container.exec({
      Cmd: ["sh", "-c", command],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const stream = await exec.start();

    stream.on("data", (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk.toString("utf8"));
      }
    });

    stream.on("end", () => {
      if (ws.readyState === ws.OPEN) {
        ws.send("\nCommand execution completed\n");
      }
    });

    stream.on("error", (err) => {
      log.error("Exec stream error:", err);
      if (ws.readyState === ws.OPEN) {
        ws.send(`Error in exec stream: ${err.message}`);
      }
    });
  } catch (err) {
    log.error("Failed to execute command:", err);
    if (ws.readyState === ws.OPEN) {
      ws.send(`Failed to execute command: ${err.message}`);
    }
  }
}

// ==============================================
// POWER ACTIONS (start/stop/restart) - FULLY PRESERVED
// ==============================================
async function performPowerAction(ws, container, action) {
  const actionMap = {
    start: container.start.bind(container),
    stop: container.stop.bind(container),
    restart: container.restart.bind(container),
  };

  if (!actionMap[action]) {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\u001b[33m[kswings] \x1b[0mInvalid action: ${action}\r\n`);
    }
    return;
  }

  const containerId = container.id;

  // Disk limit check (exactly as you had it)
  if (action === "start" || action === "restart") {
    try {
      const containerInfo = await container.inspect();
      const dataMount = containerInfo.Mounts.find(
        (m) => m.Type === "bind" && m.Destination === "/app/data"
      );

      if (dataMount) {
        const volumePath = dataMount.Source;
        const volumeId = path.basename(volumePath);
        const statesFilePath = path.join(__dirname, "../../storage/states.json");

        if (fs.existsSync(statesFilePath)) {
          const statesData = JSON.parse(fs.readFileSync(statesFilePath, "utf8"));
          if (statesData[volumeId] && statesData[volumeId].diskLimit > 0) {
            const volumeSize = await statsHandler.getVolumeSize(volumeId);
            const volumeSizeMiB = parseFloat(volumeSize) || 0;

            if (volumeSizeMiB >= statesData[volumeId].diskLimit) {
              if (ws.readyState === ws.OPEN) {
                ws.send(
                  `\r\n\u001b[31m[kswings] \x1b[0mCannot ${action}: storage limit exceeded (${volumeSizeMiB.toFixed(2)} MiB / ${statesData[volumeId].diskLimit} MiB). Delete files or increase limit.\r\n`
                );
              }
              return;
            }
          }
        }
      }
    } catch (checkErr) {
      log.warn("Failed to check storage limit for power action:", checkErr.message);
    }
  }

  const message = `\r\n\u001b[33m[kswings] \x1b[0mWorking on ${action}...\r\n`;
  if (ws.readyState === ws.OPEN) ws.send(message);

  try {
    // Start streaming logs BEFORE the power action → stop/restart logs are captured
    // (Still safe – no duplicate streams)
    streamDockerLogs(ws, container);

    await actionMap[action]();

    const successMessage = `\r\n\u001b[32m[kswings] \x1b[0m${action.charAt(0).toUpperCase() + action.slice(1)} action completed.\r\n`;
    if (ws.readyState === ws.OPEN) ws.send(successMessage);
  } catch (err) {
    log.error(`Error performing ${action} action:`, err.message);
    const errorMessage = `\r\n\u001b[31m[kswings] \x1b[0mAction failed: ${err.message}\r\n`;
    if (ws.readyState === ws.OPEN) ws.send(errorMessage);
  }
}

// ==============================================
// SETUP EXEC SESSION (used by console WS)
// ==============================================
function setupExecSession(ws, container) {
  streamDockerLogs(ws, container);
}

// Legacy functions kept for compatibility
function initializeContainerLogs() {} // no-op
function formatLogMessage(content) {
  return content; // raw passthrough
}

module.exports = {
  initializeContainerLogs,
  formatLogMessage,
  streamDockerLogs,
  executeCommand,
  performPowerAction,
  setupExecSession,
};
