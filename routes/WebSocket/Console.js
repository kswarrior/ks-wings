const fs = require("node:fs");
const path = require("path");
const CatLoggr = require("cat-loggr");
const log = new CatLoggr();
const statsHandler = require("./Stats.js");

const containerLogs = {}; // Global store for logs

function initializeContainerLogs(containerId) {
  if (!containerLogs[containerId]) {
    containerLogs[containerId] = [];
  }
}

function formatLogMessage(logMessage) {
  const { content } = logMessage;
  return content
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => `\r\n\u001b[34m[docker] \x1b[0m${line}\r\n`)
    .join('');
}

async function streamDockerLogs(ws, container) {
  const containerId = container.id;
  initializeContainerLogs(containerId);

  if (containerLogs[containerId].length > 0) {
    containerLogs[containerId].forEach((logMessage) => {
      ws.send(formatLogMessage(logMessage));
    });
  }

  try {
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 0,
    });

    if (!logStream) {
      throw new Error("Log stream is undefined");
    }

    logStream.on("data", (chunk) => {
      // === ONLY CHANGE: Strip Docker's 8-byte binary header (stdout/stderr frame) ===
      let content = chunk.length > 8 
        ? chunk.slice(8).toString('utf8') 
        : chunk.toString('utf8');

      const logMessage = {
        timestamp: new Date().toISOString(),
        content: content,
      };
      containerLogs[containerId].push(logMessage);
      const formattedMessage = formatLogMessage(logMessage);
      if (ws.readyState === ws.OPEN && ws.bufferedAmount === 0) {
        ws.send(formattedMessage);
      }
    });

    logStream.on("error", (err) => {
      log.error(`Docker log stream error: ${err.message}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n\u001b[31m[kswings] \x1b[0mLog stream error: ${err.message}\r\n`);
      }
    });

    ws.on('close', () => {
      try {
        logStream.destroy();
      } catch (_) {}
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
      Cmd: ['sh', '-c', command],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true
    });
    const stream = await exec.start();
    stream.on("data", (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk.toString('utf8'));
      }
    });
    stream.on("end", () => {
      if (ws.readyState === ws.OPEN) {
        ws.send('\nCommand execution completed');
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
    if (action === "restart" || action === "stop") {
      containerLogs[containerId] = [];
    }

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

function setupExecSession(ws, container) {
  streamDockerLogs(ws, container);
}

module.exports = {
  initializeContainerLogs,
  formatLogMessage,
  streamDockerLogs,
  executeCommand,
  performPowerAction,
  setupExecSession
};
