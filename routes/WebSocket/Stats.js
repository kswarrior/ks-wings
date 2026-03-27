const fs = require("node:fs");
const path = require("path");
const CatLoggr = require("cat-loggr");
const log = new CatLoggr();

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

async function setupStatsStreaming(ws, container, volumeId) {
  const statesFilePath = path.join(__dirname, "../../storage/states.json");
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
        // ✅ FIXED: Send Pterodactyl/ks-panel format that the frontend expects
        // The panel proxy + instance.ejs Chart.js looks for { event: "stats", args: [data] }
        ws.send(JSON.stringify({
          event: "stats",
          args: [stats]
        }));
      }
    } catch (err) {
      log.error(`Failed to fetch stats for container ${container.id}:`, err.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          event: "stats",
          args: [{ error: "Failed to fetch stats" }]
        }));
      }
    }
  };

  const statsInterval = setInterval(fetchStats, 1000);

  ws.on('close', () => {
    clearInterval(statsInterval);
  });
}

module.exports = {
  getVolumeSize,
  calculateDirectorySizeAsync,
  formatBytes,
  setupStatsStreaming
};
