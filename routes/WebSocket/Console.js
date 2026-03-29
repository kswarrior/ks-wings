const fs = require("node:fs");
const path = require("path");
const CatLoggr = require("cat-loggr");
const log = new CatLoggr();
const statsHandler = require("./Stats.js");

// ==============================================
// PROPER DOCKER LOG STREAM (fixed & optimized)
// ==============================================
async function streamDockerLogs(ws, container) {
  const containerId = container.id;

  try {
    // tail: 200 + follow = INSTANT connection + smooth live view
    // (exactly like "docker logs -f --tail 200")
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 200,                    // ← critical for instant & smooth
    });

    if (!logStream) {
      throw new Error("Log stream is undefined");
    }

    let buffer = Buffer.alloc(0);   // ← fixes "0 INFO] 1 InFO]" garbage

    logStream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      let offset = 0;
      while (buffer.length - offset >= 8) {
        const frameLength = buffer.readUInt32BE(offset + 4);

        // Not enough data for complete frame yet → wait for next chunk
        if (buffer.length - offset < 8 + frameLength) break;

        const payload = buffer.subarray(offset + 8, offset + 8 + frameLength);
        let content = payload.toString("utf8");

        // Make terminal lines clean and smooth
        content = content.replace(/\n/g, "\r\n");

        if (ws.readyState === ws.OPEN && ws.bufferedAmount === 0) {
          ws.send(content);
        }

        offset += 8 + frameLength;
      }

      // Keep any remaining partial frame for next chunk
      buffer = buffer.subarray(offset);
    });

    logStream.on("error", (err) => {
      log.error(`Docker log stream error: ${err.message}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n\u001b[31m[kswings] \x1b[0mLog stream error: ${err.message}\r\n`);
      }
    });

    ws.on("close", () => {
      try {
        logStream.destroy();
      } catch (_) {}
      log.info(`WebSocket client disconnected from container ${containerId}`);
    });

  } catch (err) {
    log.error(`Failed to attach Docker logs for ${containerId}: ${err.message}`);
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
// POWER ACTIONS (start/stop/restart) - FULLY FIXED
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

  // Disk limit check (exactly as you had it - preserved)
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
                  `\r\n\u001b[31m[kswings] \x1b[0mCannot \( {action}: storage limit exceeded ( \){volumeSizeMiB.toFixed(2)} MiB / ${statesData[volumeId].diskLimit} MiB). Delete files or increase limit.\r\n`
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
    // CRITICAL FIX: Do NOT call streamDockerLogs here
    // (this was causing doubled lines every time you clicked start/restart/stop)
    await actionMap[action]();

    const successMessage = `\r\n\u001b[32m[kswings] \x1b[0m${action.charAt(0).toUpperCase() + action.slice(1)} action completed.\r\n`;
    if (ws.readyState === ws.OPEN) ws.send(successMessage);
  } catch (err) {
    log.error(`Error performing ${action} action on ${containerId}:`, err.message);
    const errorMessage = `\r\n\u001b[31m[kswings] \x1b[0mAction failed: ${err.message}\r\n`;
    if (ws.readyState === ws.OPEN) ws.send(errorMessage);
  }
}

// ==============================================
// SETUP EXEC SESSION (called once per console connect)
// ==============================================
function setupExecSession(ws, container) {
  streamDockerLogs(ws, container);   // ← only called here (once)
}

// Legacy functions kept for compatibility (no-op)
function initializeContainerLogs() {} 
function formatLogMessage(content) {
  return content;
}

module.exports = {
  initializeContainerLogs,
  formatLogMessage,
  streamDockerLogs,
  executeCommand,
  performPowerAction,
  setupExecSession,
};
