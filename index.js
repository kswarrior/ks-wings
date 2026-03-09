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
const containerLogs = {}; // Global: Store logs for each container in memory

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

app.get("/stats", async (req, res) => {
  log.debug('Stats endpoint called');

  try {
    const totalStats = statsLogger.getSystemStats.total(); // Assuming this returns system stats object
    const containers = await docker.listContainers({ all: true });
    const onlineContainersCount = containers.filter(
      (container) => container.State === "running"
    ).length;
    const uptimeInSeconds = process.uptime();

    const formatUptime = (uptime) => {
      const minutes = Math.floor((uptime / 60) % 60);
      const hours = Math.floor((uptime / 3600) % 24);
      const days = Math.floor(uptime / 86400);
      const parts = [];

      if (days > 0) parts.push(`${days}d`);
      if (hours > 0) parts.push(`${hours}h`);
      if (minutes > 0) parts.push(`${minutes}m`);
      if (parts.length === 0) return "0m";

      return parts.join(" ");
    };

    const responseStats = {
      totalStats,
      onlineContainersCount,
      uptime: formatUptime(uptimeInSeconds),
    };

    res.json(responseStats);
  } catch (error) {
    log.error("Error fetching stats:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// FTP
start();

// Dynamic router loading
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
            app.use('/', router); // Mount at root as per original
            log.info(`Loaded router: ${routeName}`);
          } else {
            log.warn(`File ${file} isn't a router. Not loading it`);
          }
        } catch (error) {
          log.error(`Error loading router from ${file}: ${error.message}`);
          // Continue loading others
        }
      }
    });
    log.info("All routers loaded successfully.");
  } catch (err) {
    log.error(`Error reading routes directory: ${err.message}`);
  }
}

// Global utility functions
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

  // Send buffered logs first
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
      const logMessage = {
        timestamp: new Date().toISOString(),
        content: chunk.toString(),
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

    ws.on("close", () => {
      try {
        logStream.destroy();
      } catch (_) {}
      log.info("WebSocket client disconnected from logs");
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
    if (!fs.existsSync(volumePath)) {
      return "0";
    }
    const totalSize = await calculateDirectorySizeAsync(volumePath);
    return (totalSize / (1024 * 1024)).toFixed(2); // MiB as string
  } catch (err) {
    log.warn(`Failed to calculate volume size for ${volumeId}: ${err.message}`);
    return "0";
  }
}

function calculateDirectorySizeAsync(dirPath, currentDepth = 0) {
  return new Promise((resolve, reject) => {
    if (currentDepth >= 500) {
      log.warn(`Maximum depth reached at ${dirPath}`);
      resolve(0);
      return;
    }

    let totalSize = 0;
    fs.readdir(dirPath, { withFileTypes: true }, (err, files) => {
      if (err) {
        reject(err);
        return;
      }

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
            calculateDirectorySizeAsync(filePath, currentDepth + 1)
              .then((size) => {
                totalSize += size;
                processed++;
                if (processed === totalFiles) resolve(totalSize);
              })
              .catch(reject);
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

async function performPowerAction(ws, container, action) {
  const actionMap = {
    start: 'start',
    stop: 'stop', // Use stop instead of kill for graceful
    restart: 'restart',
  };

  if (!actionMap[action]) {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\u001b[33m[kswings] \x1b[0mInvalid action: ${action}\r\n`);
    }
    return;
  }

  const containerId = container.id;

  // Check storage limit before start/restart
  if (action === "start" || action === "restart") {
    try {
      const containerInfo = await container.inspect();
      const dataMount = containerInfo.Mounts.find(
        (m) => m.Type === "bind" && m.Destination === "/app/data"
      );

      if (dataMount) {
        const volumePath = dataMount.Source;
        const volumeId = path.basename(volumePath);

        const statesFilePath = path.join(__dirname, "storage/states.json");
        if (fs.existsSync(statesFilePath)) {
          const statesData = JSON.parse(fs.readFileSync(statesFilePath, "utf8"));
          if (statesData[volumeId] && statesData[volumeId].diskLimit > 0) {
            const volumeSize = await getVolumeSize(volumeId);
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

  const timestamp = new Date().toISOString();
  const message = `\r\n\u001b[33m[kswings] \x1b[0mWorking on ${action}...\r\n`;
  if (ws.readyState === ws.OPEN) ws.send(message);

  try {
    if (action === "restart" || action === "stop") {
      containerLogs[containerId] = [];
    }

    // Start log streaming before action for startup logs
    streamDockerLogs(ws, container);

    await container[actionMap[action]]();

    const successMessage = `\r\n\u001b[32m[kswings] \x1b[0m${action.charAt(0).toUpperCase() + action.slice(1)} action completed.\r\n`;
    if (ws.readyState === ws.OPEN) ws.send(successMessage);
  } catch (err) {
    log.error(`Error performing ${action} action:`, err.message);
    const errorMessage = `\r\n\u001b[31m[kswings] \x1b[0mAction failed: ${err.message}\r\n`;
    if (ws.readyState === ws.OPEN) ws.send(errorMessage);
  }
}

// WebSocket Server Initialization
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
        authenticateWebSocket(ws, req, msg.args[0], (authenticated, containerId, volumeId) => {
          if (authenticated) {
            isAuthenticated = true;
            handleWebSocketConnection(ws, req, containerId, volumeId);
          } else {
            if (ws.readyState === ws.OPEN) ws.send("Authentication failed");
            ws.close(1008, "Authentication failed");
          }
        });
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

    async function setupExecSession(ws, container) {
      streamDockerLogs(ws, container);
    }

    async function setupStatsStreaming(ws, container, volumeId) {
      // Read disk limit from states
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

          const volumeSize = await getVolumeSize(volumeId);
          stats.volumeSize = volumeSize;
          stats.diskLimit = diskLimit;
          const volumeSizeMiB = parseFloat(volumeSize) || 0;
          const storageExceeded = diskLimit > 0 && volumeSizeMiB >= diskLimit;
          stats.storageExceeded = storageExceeded;

          // Auto-stop if exceeded and running
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

      const statsInterval = setInterval(fetchStats, 1000); // 1s interval for real-time feel

      ws.on('close', () => {
        clearInterval(statsInterval);
        log.debug(`Stats streaming stopped for container ${containerId}`);
      });
    }
  });

  log.info("WebSocket server initialized");
}

// Root endpoint for health check
app.get("/", async (req, res) => {
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

    res.json(response);
  } catch (error) {
    log.error("Error fetching Docker status:", error);
    res.status(500).json({
      error: "Docker is not running - kswings will not function properly.",
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  log.error(err.stack);
  res.status(500).send("Something has... gone wrong!");
});

// Start server
server.listen(config.port || 8080, () => {
  log.info(`kswings is listening on port ${config.port || 8080}`);
  initializeWebSocketServer(server);
  log.info("ks-wings is online and ready.");
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});
