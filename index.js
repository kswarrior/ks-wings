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

/**
 * Initializes a WebSocket server tied to the HTTP server. This WebSocket server handles real-time
 * interactions such as authentication, container statistics reporting, logs streaming, and container
 * control commands (start, stop, restart). The WebSocket server checks for authentication on connection
 * and message reception, parsing messages as JSON and handling them according to their specified event type.
 */
const app = express();
const server = http.createServer(app);

const log = new CatLoggr();

/**
 * Sets up Express application middleware for JSON body parsing and basic authentication using predefined
 * user keys from the configuration. Initializes routes for managing Docker instances, deployments, and
 * power controls. These routes are grouped under the '/instances' path.
 */
console.log(chalk.gray(ascii) + chalk.white(`version v${config.version}\n`));
async function init() {
  try {
    const ping = await docker.ping();
    // not the best way to check if docker is running, but it works
    if (ping.includes("error: connect ENOENT")) {
      log.error("Docker is not running - kswings will not function properly.");
      log.error("Please check if Docker is running and try again.");
      process.exit();
    }

    const volumesPath = path.join(__dirname, "./volumes");
    await fs2.mkdir(volumesPath, { recursive: true });

    log.info("volumes folder created successfully");

    const storagePath = path.join(__dirname, "./storage");
    await fs2.mkdir(storagePath, { recursive: true });

    log.info("storage folder created successfully");

    // Node Stats
    statsLogger.initLogger();
    
    loadRouters();
  } catch (error) {
    log.error(
      "failed to retrieve image list from remote! the panel might be down. error:",
      error.message
    );
    process.exit();
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
      console.error("Error logging stats:", error);
    }
  }, 10000);
}

startLoggingStats();

app.get("/stats", async (req, res) => {
  log.debug('Stats endpoint called');  // ADD: As requested
  try {
    const totalStats = statsLogger.getSystemStats.total();
    const containers = await docker.listContainers({ all: true });
    //console.log("test ", containers);
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

// Function to dynamically load routers
function loadRouters() {
  const routesDir = path.join(__dirname, "routes");
  try {
    const files = fs.readdirSync(routesDir);
    
    files.forEach((file) => {
      if (file.endsWith(".js")) {
        try {
          const routerPath = path.join(routesDir, file);
          const router = require(routerPath);
          if (typeof router === "function" && router.name === "router") {
            const routeName = path.parse(file).name;
            app.use(`/`, router);
            log.info(`Loaded router: ${routeName}`);
          } else {
            log.warn(`File ${file} isn't a router. Not loading it`);
          }
        } catch (error) {
          log.error(`Error loading router from ${file}: ${error.message}`);
        }
      }
    });
  } catch (err) {
    log.error(`Error reading routes directory: ${err.message}`);
  }
}

/**
 * Initializes a WebSocket server tied to the HTTP server. This WebSocket server handles real-time
 * interactions such as authentication, container statistics reporting, logs streaming, and container
 * control commands (start, stop, restart). The WebSocket server checks for authentication on connection
 * and message reception, parsing messages as JSON and handling them according to their specified event type.
 *
 * @param {http.Server} server - The HTTP server to bind the WebSocket server to.
 */
function initializeWebSocketServer(server) {
  const wss = new WebSocket.Server({ server }); // use express-ws so you can have multiple ws's, api routes & that on 1 server.
  const containerLogs = {}; // Store logs for each container in memory

  wss.on("connection", (ws, req) => {
    let isAuthenticated = false;

    ws.on("message", async (message) => {
      log.debug("got " + message);
      let msg = {};
      try {
        msg = JSON.parse(message);
      } catch (error) {
        ws.send("Invalid JSON");
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
              ws.send("Authentication failed");
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
            executeCommand(ws, container, msg.command);
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
            ws.send("Unsupported event");
            break;
        }
      } else {
        ws.send("Unauthorized access");
        ws.close(1008, "Unauthorized access");
      }
    });

    function authenticateWebSocket(ws, req, password, callback) {
      if (password === config.key) {
        log.info("successful authentication on ws");
        ws.send(`\r\n\u001b[33m[kswings] \x1b[0mconnected!\r\n`);
        const urlParts = req.url.split("/");
        const containerId = urlParts[2];
        const volumeId = urlParts[3] || 0;

        if (!containerId) {
          ws.close(1008, "Container ID not specified");
          callback(false, null);
          return;
        }

        callback(true, containerId, volumeId);
      } else {
        log.warn("authentication failure on websocket!");
        callback(false, null);
      }
    }

    /**
     * Handles an incoming WebSocket connection.
     *
     * @param {WebSocket} ws - The incoming WebSocket object
     * @param {Request} req - The request that triggered the WebSocket connection
     * @param {string} containerId - The ID of the container to connect to
     * @param {number} volumeId - The volume ID to connect to (or 0 for the default volume)
     */
    function handleWebSocketConnection(ws, req, containerId, volumeId) {
      const container = docker.getContainer(containerId);
      const volume = volumeId || 0;

      container.inspect(async (err, data) => {
        if (err) {
          ws.send("Container not found");
          return;
        }

        if (req.url.startsWith("/exec/")) {
          setupExecSession(ws, container);
        } else if (req.url.startsWith("/stats/")) {
          setupStatsStreaming(ws, container, volume);
        } else {
          ws.close(1002, "URL must start with /exec/ or /stats/");
        }
      });
    }

    function initializeContainerLogs(containerId) {
      containerLogs[containerId] = [];
    }

    async function streamDockerLogs(ws, container) {
  const containerId = container.id;

  if (!containerLogs[containerId]) {
    initializeContainerLogs(containerId);
  }

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

      // Rate limit check
      if (ws.readyState === ws.OPEN && ws.bufferedAmount === 0) {
        ws.send(formattedMessage);
      }
    });

    logStream.on("error", (err) => {
      log.error(`Docker log stream error: ${err.message}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(
          `\r\n\u001b[31m[kswings] \x1b[0mLog stream error: ${err.message}\r\n`
        );
      }
    });

    ws.on("close", () => {
      try {
        logStream.destroy();
      } catch (_) {}
      log.info("WebSocket client disconnected");
    });
  } catch (err) {
    log.error(`Failed to attach Docker logs: ${err.message}`);

    if (ws.readyState === ws.OPEN) {
      ws.send(
        `\r\n\u001b[31m[kswings] \x1b[0mFailed to attach logs: ${err.message}\r\n`
      );
    }
  }
}

    // Helper function to format log messages
    const formatLogMessage = (logMessage) => {
      const { content } = logMessage;
      return content
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => `\r\n\u001b[34m[docker] \x1b[0m${line}\r\n`)
        .join('');
    };

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

      let hasAutoStopped = false; // Prevent multiple stop attempts

      const fetchStats = async () => {
        try {
          const stats = await new Promise((resolve, reject) => {
            container.stats({ stream: false }, (err, stats) => {
              if (err) {
                reject(new Error("Failed to fetch stats"));
              } else {
                resolve(stats);
              }
            });
          });

          // Calculate volume size (now returns MiB as string number)
          const volumeSize = await getVolumeSize(volumeId);

          // Add volume size to stats object
          stats.volumeSize = volumeSize;
          stats.diskLimit = diskLimit;
          
          // Check if storage is exceeded (volumeSize is now a number string in MiB)
          const volumeSizeMiB = parseFloat(volumeSize) || 0;
          const storageExceeded = diskLimit > 0 && volumeSizeMiB >= diskLimit;
          stats.storageExceeded = storageExceeded;

          // Auto-stop container if storage exceeded and container is running
          if (storageExceeded && !hasAutoStopped) {
            const containerInfo = await container.inspect();
            if (containerInfo.State.Running) {
              log.warn(`Storage exceeded for container ${container.id} - auto-stopping`);
              await container.stop();
              hasAutoStopped = true;
            }
          }

          ws.send(JSON.stringify(stats));
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
}

initializeWebSocketServer(server);

server.listen(config.port, () => {
  log.info(`KS Wings listening on port ${config.port}`);
});
