const fs = require("node:fs");
const path = require("path");
const CatLoggr = require("cat-loggr");
const log = new CatLoggr();
const statsHandler = require("./Stats.js");

// Removed: global containerLogs + old formatLogMessage (no longer needed)

async function streamDockerLogs(ws, container) {
  const containerId = container.id;

  try {
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 200,                    // ← instant recent history (smooth & fast)
    });

    if (!logStream) {
      throw new Error("Log stream is undefined");
    }

    let buffer = Buffer.alloc(0);   // proper multi-frame parser

    logStream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      let offset = 0;
      while (buffer.length - offset >= 8) {
        const frameLength = buffer.readUInt32BE(offset + 4);
        if (buffer.length - offset < 8 + frameLength) break; // incomplete frame

        const payload = buffer.subarray(offset + 8, offset + 8 + frameLength);
        let content = payload.toString("utf8");

        // Make sure terminal displays cleanly
        content = content.replace(/\n/g, "\r\n");

        if (ws.readyState === ws.OPEN && ws.bufferedAmount === 0) {
          ws.send(content);
        }

        offset += 8 + frameLength;
      }
      buffer = buffer.subarray(offset); // keep remainder for next chunk
    });

    logStream.on("error", (err) => {
      log.error(`Docker log stream error: ${err.message}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n\u001b[31m[kswings] \x1b[0mLog stream error: ${err.message}\r\n`);
      }
    });

    ws.on("close", () => {
      try { logStream.destroy(); } catch (_) {}
      log.info("WebSocket client disconnected");
    });
  } catch (err) {
    log.error(`Failed to attach Docker logs: ${err.message}`);
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\u001b[31m[kswings] \x1b[0mFailed to attach logs: ${err.message}\r\n`);
    }
  }
}

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
      if (ws.readyState === ws.OPEN) ws.send(chunk.toString("utf8"));
    });
    stream.on("end", () => {
      if (ws.readyState === ws.OPEN) ws.send("\nCommand execution completed");
    });
    stream.on("error", (err) => {
      log.error("Exec stream error:", err);
      if (ws.readyState === ws.OPEN) ws.send(`Error in exec stream: ${err.message}`);
    });
  } catch (err) {
    log.error("Failed to execute command:", err);
    if (ws.readyState === ws.OPEN) ws.send(`Failed to execute command: ${err.message}`);
  }
}

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

  const message = `\r\n\u001b[33m[kswings] \x1b[0mWorking on ${action}...\r\n`;
  if (ws.readyState === ws.OPEN) ws.send(message);

  try {
    // Removed: old containerLogs clear + streamDockerLogs call
    // (prevents double lines + we now use native tail:200)

    await actionMap[action]();

    const successMessage = `\r\n\u001b[32m[kswings] \x1b[0m${action.charAt(0).toUpperCase() + action.slice(1)} action completed.\r\n`;
    if (ws.readyState === ws.OPEN) ws.send(successMessage);
  } catch (err) {
    log.error(`Error performing ${action} action:`, err.message);
    const errorMessage = `\r\n\u001b[31m[kswings] \x1b[0mAction failed: ${err.message}\r\n`;
    if (ws.readyState === ws.OPEN) ws.send(errorMessage);
  }
}

function setupExecSession(ws, container) {
  streamDockerLogs(ws, container);   // only called once per console connection
}

module.exports = {
  streamDockerLogs,
  executeCommand,
  performPowerAction,
  setupExecSession,
};
