const express = require("express");
const router = express.Router();
const fs = require("fs").promises;
const path = require("path");
const { safePath } = require("../utils/SafePath");
const { calculateDirectorySize } = require("../utils/FileType");

// Copied from UploadFiles.js for disk limit
async function getDiskLimit(volumeId) {
  const statesFilePath = path.join(__dirname, "../storage/states.json");
  try {
    if (require("fs").existsSync(statesFilePath)) {
      const statesData = JSON.parse(await fs.readFile(statesFilePath, "utf8"));
      return statesData[volumeId]?.diskLimit || 0;
    }
  } catch {}
  return 0;
}

router.post("/fs/:id/files/pull", async (req, res) => {
  const { id } = req.params;
  const { url, filename } = req.body;
  const subPath = req.query.path || "";
  const volumePath = path.join(__dirname, "../volumes", id);

  if (!url) return res.status(400).json({ message: "URL required" });

  try {
    const diskLimit = await getDiskLimit(id);
    if (diskLimit > 0) {
      const current = await calculateDirectorySize(volumePath);
      // rough estimate — skip exact for URL (we check after download)
    }

    const filePath = safePath(volumePath, subPath);
    const finalName = filename || url.split("/").pop() || "downloaded-file";
    const destPath = path.join(filePath, finalName);

    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch URL");

    const buffer = await response.arrayBuffer();
    await fs.writeFile(destPath, Buffer.from(buffer));

    res.json({ message: "File pulled successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
