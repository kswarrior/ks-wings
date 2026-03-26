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

// Load split WebSocket handlers from routes/WebSocket/
const consoleHandler = require("./routes/WebSocket/Console.js");
const statsHandler = require("./routes/WebSocket/Stats.js");

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

// Enhanced /stats with bulletproof error handling and logging
app.get("/stats", async (req, res) => {
  log.debug('Stats endpoint called - starting processing');

  let totalStats = { cpu: 0, ram: { total: 0, used: 0 }, disk: { total: 0, used: 0 } }; // Fallback
  let onlineContainersCount = 0;
  let uptime = "0m";

  try {
    // Handle statsLogger safely
    log.debug('Fetching system stats...');
    try {
      const statsObj = statsLogger.getSystemStats;
      if (typeof statsObj.total === 'function') {
        totalStats = statsObj.total();
        log.debug('System stats fetched successfully');
      } else {
        log.warn('total() not a function on getSystemStats - using fallback');
      }
    } catch (statsErr) {
      log.error("Error in statsLogger:", statsErr);
    }

    // Handle Docker containers safely
    log.debug('Fetching Docker containers...');
    try {
      const containers = await docker.listContainers({ all: true });
      onlineContainersCount = containers.filter(
        (container) => container.State === "running"
      ).length;
      log.debug(`Found ${containers.length} containers, ${onlineContainersCount} online`);
    } catch (dockerErr) {
      log.error("Error listing containers:", dockerErr);
    }

    // Uptime calculation (always safe)
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
    res.status(500).json({ error: "Failed to fetch stats", uptime: "0m" }); // Ensure uptime is set for panel check
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
            if (msg.args && msg.args[0]) consoleHandler.executeCommand(ws, container, msg.args[0]);
            else if (msg.command) consoleHandler.executeCommand(ws, container, msg.command); // Fallback for old format
            break;
          case "power:start":
            consoleHandler.performPowerAction(ws, container, "start");
            break;
          case "power:stop":
            consoleHandler.performPowerAction(ws, container, "stop");
            break;
          case "power:restart":
            consoleHandler.performPowerAction(ws, container, "restart");
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
          consoleHandler.setupExecSession(ws, container);
        } else if (req.url.startsWith("/stats/")) {
          statsHandler.setupStatsStreaming(ws, container, volumeId);
        } else {
          ws.close(1002, "URL must start with /exec/ or /stats/");
        }
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

// Listen immediately with explicit online log
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
