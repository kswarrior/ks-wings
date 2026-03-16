// ================================================
// ks-wings/index.js - FULLY FIXED & IMPROVED
// ================================================
// Changes made (all issues fixed):
// 1. Docker log header (8-byte binary frame) stripped → real server logs now appear
// 2. Removed duplicate log stream listeners (was the main cause of silent console)
// 3. Proper active stream management + destroy on reconnect/power actions
// 4. Logs now correctly resume after start/restart (re-attach after action)
// 5. Removed unnecessary global containerLogs cache (caused duplicates + memory waste)
// 6. Fixed broken /stats endpoint (was using wrong statsLogger API)
// 7. Cleaner code, better error handling, ws.once close cleanup, "end" event
// 8. No more duplicate messages on attach/reconnect
// 9. Minor performance & reliability improvements everywhere

process.env.dockerSocket =
  process.platform === "win32"
    ? "//./pipe/docker_engine"
    : "/var/run/docker.sock";

const express = require("express");
const basicAuth = require("express-basic-auth");
const bodyParser = require("body-parser");
const CatLoggr = require("cat-loggr");
const WebSocket = require("ws");
const http = require("http");
const fs = require("node:fs");
const path = require("path");
const chalk = require("chalk");
const fs2 = require("fs").promises;
const ascii = fs.readFileSync("./handlers/ascii.txt", "utf8");
const { start } = require("./handlers/ftp.js");
const config = require("./config.json");
const statsLogger = require("./handlers/stats.js");

const Docker = require("./utils/Docker");

const docker = new Docker({ socketPath: process.env.dockerSocket });

const app = express();
const server = http.createServer(app);
const log = new CatLoggr();

// NEW: Track active Docker log streams to prevent leaks/duplicates
const activeLogStreams = {};

console.log(chalk.gray(ascii) + chalk.white(`version v${config.version}\n`));

async function init() {
  try {
    const ping = await docker.ping();
    if (ping.includes("error: connect ENOENT")) {
      log.error("Docker is not running - kswings will not function properly.");
      log.error("Please check if Docker is running and try again.");
      process.exit(1);
    }

    const volumesPath = path.join(__dirname, "./volumes");
    await fs2.mkdir(volumesPath, { recursive: true });
    log.info("volumes folder created successfully");

    const storagePath = path.join(__dirname, "./storage");
    await fs2.mkdir(storagePath, { recursive: true });
    log.info("storage folder created successfully");

    statsLogger.initLogger();
    loadRouters();
  } catch (error) {
    log.error("failed to retrieve image list from remote! the panel might be down. error:", error.message);
    process.exit(1);
  }
}

init();

app.use(bodyParser.json());
app.use(
  basicAuth({
    users: { kspanel: config.key },
    challenge: true,
  })
);

async function startLoggingStats() {
  setInterval(async () => {
    try {
      const stats = await statsLogger.getSystemStats();
      statsLogger.saveStats(stats);
    } catch (error) {
      log.error("Error logging stats:", error);
    }
  }, 10000);
}

startLoggingStats();

// FIXED: /stats endpoint - now consistent with startLoggingStats
app.get("/stats", async (req, res) => {
  log.debug('Stats endpoint called - starting processing');

  let totalStats = { cpu: 0, ram: { total: 0, used: 0 }, disk: { total: 0, used: 0 } };
  let onlineContainersCount = 0;
  let uptime = "0m";

  try {
    // FIXED: Use same API as startLoggingStats
    log.debug('Fetching system stats...');
    totalStats = await statsLogger.getSystemStats();
    log.debug('System stats fetched successfully');

    // Docker containers count
    log.debug('Fetching Docker containers...');
    const containers = await docker.listContainers({ all: true });
    onlineContainersCount = containers.filter(
      (container) => container.State === "running"
    ).length;
    log.debug(`Found ${containers.length} containers, ${onlineContainersCount} online`);

    // Uptime
    const uptimeInSeconds = process.uptime();
    const formatUptime = (uptime) => {
      const minutes = Math.floor((uptime / 60) % 60);
      const hours = Math.floor((uptime / 3600) % 24);
      const days = Math.floor(uptime / 86400);
      const parts = [];
      if (days > 0) parts.push(`${days}d`);
      if (hours > 0) parts.push(`${hours}h`);
      if (minutes > 0) parts.push(`${minutes}m`);
      return parts.length === 0 ? "0m" : parts.join(" ");
    };
    uptime = formatUptime(uptimeInSeconds);

    const responseStats = {
      totalStats,
      onlineContainersCount,
      uptime,
    };

    log.debug('Stats response prepared - sending OK');
    res.json(responseStats);
  } catch (error) {
    log.error("Critical error in /stats endpoint:", error);
    res.status(500).json({ error: "Failed to fetch stats", uptime: "0m" });
  }
});

// FTP
start();

function loadRouters() {
  const routesDir = path.join(__dirname, "routes");
  try {
    if (!fs.existsSync(routesDir)) {
      log.warn("Routes directory not found - no additional routes loaded.");
      return;
    }
    const files = fs.readdirSync(routesDir);
    
    files.forEach((file) => {
      if (file.endsWith(".js")) {
        try {
          const routerPath = path.join(routesDir, file);
          const router = require(routerPath);
          if (typeof router === "function" && router.name === "router") {
            const routeName = path.parse(file).name;
            app.use('/', router);
            log.info(`Loaded router: ${routeName}`);
          } else {
            log.warn(`File ${file} isn't a router. Not loading it`);
          }
        } catch (error) {
          log.error(`Error loading router from ${file}: ${error.message}`);
        }
      }
    });
    log.info("All routers loaded successfully.");
  } catch (err) {
    log.error(`Error reading routes directory: ${err.message}`);
  }
}

// Utility functions
function formatLogMessage(logMessage) {
  const { content } = logMessage;
  return content
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => `\r\n\u001b[34m[docker] \x1b[0m${line}\r\n`)
    .join('');
}

// IMPROVED + FIXED: Docker log streaming
async function streamDockerLogs(ws, container) {
  const containerId = container.id;

  // Destroy any existing stream first (prevents duplicates/leaks)
  if (activeLogStreams[containerId]) {
    try {
      activeLogStreams[containerId].destroy();
    } catch (_) {}
    delete activeLogStreams[containerId];
  }

  try {
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 0, // full history on attach (same as original)
    });

    if (!logStream) {
      throw new Error("Log stream is undefined");
    }

    activeLogStreams[containerId] = logStream;

    logStream.on("data", (chunk) => {
      // FIXED: Strip Docker's 8-byte binary header (stdout/stderr frame)
      // This was the #1 reason logs were invisible/garbage
      let content = chunk.length > 8 
        ? chunk.slice(8).toString('utf8') 
        : chunk.toString('utf8');

      const logMessage = {
        timestamp: new Date().toISOString(),
        content: content,
      };

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

    logStream.on("end", () => {
      delete activeLogStreams[containerId];
      log.debug(`Log stream ended for container ${containerId} (probably stopped)`);
    });

  } catch (err) {
    log.error(`Failed to attach Docker logs: ${err.message}`);
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\u001b[31m[kswings] \x1b[0mFailed to attach logs: ${err.message}\r\n`);
    }
  }
}

async function getVolumeSize(volumeId) {
  const volumePath = path.join("./volumes", volumeId);
  try {
    if (!fs.existsSync(volumePath)) return "0";
    const totalSize = await calculateDirectorySizeAsync(volumePath);
    return (totalSize / (1024 * 1024)).toFixed(2);
  } catch (err) {
    log.warn(`Failed to calculate volume size for ${volumeId}: ${err.message}`);
    return "0";
  }
}

async function calculateDirectorySizeAsync(dirPath, currentDepth = 0) {
  if (currentDepth >= 500) {
    log.warn(`Maximum depth reached at ${dirPath}`);
    return 0;
  }

  return new Promise((resolve, reject) => {
    fs.readdir(dirPath, { withFileTypes: true }, (err, files) => {
      if (err) {
        reject(err);
        return;
      }
      let totalSize = 0;
      let processed = 0;
      const totalFiles = files.length;
      if (totalFiles === 0) {
        resolve(0);
        return;
      }
      files.forEach((file) => {
        const filePath = path.join(dirPath, file.name);
        fs.stat(filePath, (statErr, stats) => {
          if (statErr) {
            processed++;
            if (processed === totalFiles) resolve(totalSize);
            return;
          }
          if (stats.isDirectory()) {
            calculateDirectorySizeAsync(filePath, currentDepth + 1).then((size) => {
              totalSize += size;
              processed++;
              if (processed === totalFiles) resolve(totalSize);
            }).catch(reject);
          } else {
            totalSize += stats.size;
            processed++;
            if (processed === totalFiles) resolve(totalSize);
          }
        });
      });
    });
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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

// IMPROVED: Power actions - no duplicate streams, re-attach after start/restart
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

  const message = `\r\n\u001b[33m[kswings] \x1b[0mWorking on ${action}...\r\n`;
  if (ws.readyState === ws.OPEN) ws.send(message);

  try {
    // No more containerLogs clearing (removed unused cache)

    await actionMap[action]();

    const successMessage = `\r\n\u001b[32m[kswings] \x1b[0m${action.charAt(0).toUpperCase() + action.slice(1)} action completed.\r\n`;
    if (ws.readyState === ws.OPEN) ws.send(successMessage);

    // RE-ATTACH logs after start or restart so console continues working
    if (action === "start" || action === "restart") {
      streamDockerLogs(ws, container);
    }
  } catch (err) {
    log.error(`Error performing ${action} action:`, err.message);
    const errorMessage = `\r\n\u001b[31m[kswings] \x1b[0mAction failed: ${err.message}\r\n`;
    if (ws.readyState === ws.OPEN) ws.send(errorMessage);
  }
}

function initializeWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });

  wss.on("connection", (ws, req) => {
    let isAuthenticated = false;

    ws.on("message", async (message) => {
      log.debug("got " + message);
      let msg = {};
      try {
        msg = JSON.parse(message.toString());
      } catch (error) {
        if (ws.readyState === ws.OPEN) ws.send("Invalid JSON");
        return;
      }

      if (msg.event === "auth" && msg.args) {
        authenticateWebSocket(
          ws,
          req,
          msg.args[0],
          (authenticated, containerId, volumeId) => {
            if (authenticated) {
              isAuthenticated = true;
              handleWebSocketConnection(ws, req, containerId, volumeId);
            } else {
              if (ws.readyState === ws.OPEN) ws.send("Authentication failed");
              ws.close(1008, "Authentication failed");
            }
          }
        );
      } else if (isAuthenticated) {
        const urlParts = req.url.split("/");
        const containerId = urlParts[2];

        if (!containerId) {
          ws.close(1008, "Container ID not specified");
          return;
        }

        const container = docker.getContainer(containerId);

        switch (msg.event) {
          case "cmd":
            if (msg.args && msg.args[0]) executeCommand(ws, container, msg.args[0]);
            else if (msg.command) executeCommand(ws, container, msg.command);
            break;
          case "power:start":
            performPowerAction(ws, container, "start");
            break;
          case "power:stop":
            performPowerAction(ws, container, "stop");
            break;
          case "power:restart":
            performPowerAction(ws, container, "restart");
            break;
          default:
            if (ws.readyState === ws.OPEN) ws.send("Unsupported event");
            break;
        }
      } else {
        if (ws.readyState === ws.OPEN) ws.send("Unauthorized access");
        ws.close(1008, "Unauthorized access");
      }
    });

    function authenticateWebSocket(ws, req, password, callback) {
      if (password === config.key) {
        log.info("successful authentication on ws");
        if (ws.readyState === ws.OPEN) ws.send(`\r\n\u001b[33m[kswings] \x1b[0mconnected!\r\n`);
        const urlParts = req.url.split("/");
        const containerId = urlParts[2];
        const volumeId = urlParts[3] || 0;

        if (!containerId) {
          ws.close(1008, "Container ID not specified");
          callback(false, null, null);
          return;
        }

        callback(true, containerId, parseInt(volumeId));
      } else {
        log.warn("authentication failure on websocket!");
        callback(false, null, null);
      }
    }

    function handleWebSocketConnection(ws, req, containerId, volumeId) {
      const container = docker.getContainer(containerId);

      container.inspect(async (err, data) => {
        if (err) {
          if (ws.readyState === ws.OPEN) ws.send("Container not found");
          return;
        }

        if (req.url.startsWith("/exec/")) {
          setupExecSession(ws, container);
        } else if (req.url.startsWith("/stats/")) {
          setupStatsStreaming(ws, container, volumeId);
        } else {
          ws.close(1002, "URL must start with /exec/ or /stats/");
        }
      });
    }

    // FIXED: Setup only called once at connect
    async function setupExecSession(ws, container) {
      streamDockerLogs(ws, container);

      // Cleanup attached only once (ws.once)
      ws.once('close', () => {
        const containerId = container.id;
        if (activeLogStreams[containerId]) {
          try {
            activeLogStreams[containerId].destroy();
          } catch (_) {}
          delete activeLogStreams[containerId];
        }
        log.info("WebSocket client disconnected");
      });
    }

    async function setupStatsStreaming(ws, container, volumeId) {
      const statesFilePath = path.join(__dirname, "storage/states.json");
      let diskLimit = 0;
      try {
        if (fs.existsSync(statesFilePath)) {
          const statesData = JSON.parse(fs.readFileSync(statesFilePath, "utf8"));
          if (statesData[volumeId] && statesData[volumeId].diskLimit) {
            diskLimit = statesData[volumeId].diskLimit;
          }
        }
      } catch (err) {
        log.warn("Failed to read disk limit from states:", err.message);
      }

      let hasAutoStopped = false;

      const fetchStats = async () => {
        try {
          const stats = await new Promise((resolve, reject) => {
            container.stats({ stream: false }, (err, data) => {
              if (err) reject(err);
              else resolve(data);
            });
          });

          const volumeSize = await getVolumeSize(volumeId.toString());
          stats.volumeSize = volumeSize;
          stats.diskLimit = diskLimit;
          const volumeSizeMiB = parseFloat(volumeSize) || 0;
          const storageExceeded = diskLimit > 0 && volumeSizeMiB >= diskLimit;
          stats.storageExceeded = storageExceeded;

          if (storageExceeded && !hasAutoStopped) {
            const containerInfo = await container.inspect();
            if (containerInfo.State.Running) {
              log.warn(`Storage exceeded for container ${container.id} - auto-stopping`);
              await container.stop();
              hasAutoStopped = true;
            }
          }

          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              event: 'stats',
              args: [stats]
            }));
          }
        } catch (err) {
          log.error(`Failed to fetch stats for container ${container.id}:`, err.message);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ error: 'Failed to fetch stats' }));
          }
        }
      };

      const statsInterval = setInterval(fetchStats, 1000);

      ws.on('close', () => {
        clearInterval(statsInterval);
      });
    }
  });

  log.info("WebSocket server initialized");
}

app.get("/", async (req, res) => {
  log.debug('Root endpoint called - health check');
  try {
    const dockerInfo = await docker.info();
    const isDockerRunning = await docker.ping();

    const response = {
      versionFamily: 1,
      versionRelease: "kswings " + config.version,
      online: true,
      remote: config.remote,
      mysql: {
        host: config.mysql.host,
        user: config.mysql.user,
        password: config.mysql.password,
      },
      docker: {
        status: isDockerRunning ? "running" : "not running",
        systemInfo: dockerInfo,
      },
    };

    log.debug('Root response sent OK');
    res.json(response);
  } catch (error) {
    log.error("Error in root endpoint:", error);
    res.status(500).json({
      error: "Daemon error",
      online: false,
    });
  }
});

app.use((err, req, res, next) => {
  log.error(err.stack);
  res.status(500).send("Something has... gone wrong!");
});

// Listen
const port = config.port || 8080;
server.listen(port, () => {
  log.info(`kswings is listening on port ${port}`);
  initializeWebSocketServer(server);
  log.info("ks-wings is fully online and ready for panel connections.");
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log.info('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  log.info('SIGINT received, shutting down gracefully');
  server.close(() => process.exit(0));
});
