const fs = require("node:fs");
const path = require("path");
const { execFile } = require("node:child_process");
const CatLoggr = require("cat-loggr");
const log = new CatLoggr();

// ──────────────────────────────────────────────────────────────
// Global cache + background updater (this is the magic)
const volumeSizeCache = new Map();     // volumeId → sizeInMB (string)
const activeVolumes = new Set();       // volumes currently being monitored
const CACHE_TTL_MS = 30000;            // refresh every 30 seconds

let backgroundInterval = null;

function startBackgroundUpdater() {
  if (backgroundInterval) return;
  backgroundInterval = setInterval(() => {
    activeVolumes.forEach((volumeId) => updateVolumeSizeInBackground(volumeId));
  }, CACHE_TTL_MS);
}

async function updateVolumeSizeInBackground(volumeId) {
  const volumePath = path.join("./volumes", volumeId);
  if (!fs.existsSync(volumePath)) {
    volumeSizeCache.set(volumeId, "0");
    return;
  }

  execFile("du", ["-s", "--block-size=1M", volumePath], (err, stdout) => {
    if (err) {
      log.warn(`Background du failed for ${volumeId}: ${err.message}`);
      volumeSizeCache.set(volumeId, "0");
      return;
    }
    const sizeMB = stdout.trim().split("\t")[0] || "0";
    volumeSizeCache.set(volumeId, sizeMB);
  });
}

// Fast getVolumeSize – never blocks the stats loop
async function getVolumeSize(volumeId) {
  const idStr = volumeId.toString();
  const cached = volumeSizeCache.get(idStr);

  if (cached !== undefined) return cached;

  // First time we see this volume → start background calc, return 0 instantly
  activeVolumes.add(idStr);
  startBackgroundUpdater();
  updateVolumeSizeInBackground(idStr);   // fire-and-forget
  volumeSizeCache.set(idStr, "0");       // temporary value
  return "0";
}

// ──────────────────────────────────────────────────────────────
// Keep the rest of your file exactly the same
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
      const statsRes = await container.stats({ stream: false });

      const stats = await new Promise((resolve, reject) => {
        let data = "";
        statsRes.on("data", (chunk) => { data += chunk; });
        statsRes.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
        statsRes.on("error", reject);
      });

      // ← This is now INSTANT (no await delay)
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
        ws.send(JSON.stringify(stats));
      }
    } catch (err) {
      log.error(`Failed to fetch stats for container ${container.id}:`, err.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ error: "Failed to fetch stats" }));
      }
    }
  };

  const statsInterval = setInterval(fetchStats, 1000);

  ws.on('close', () => {
    clearInterval(statsInterval);
    // Optional: clean up activeVolumes if you want (not required)
  });
}

module.exports = {
  getVolumeSize,
  formatBytes,
  setupStatsStreaming
  // you can delete calculateDirectorySizeAsync – it's no longer used
};
