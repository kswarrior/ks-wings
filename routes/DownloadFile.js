const express = require("express");
const router = express.Router();
const fs = require("fs").promises;
const path = require("path");
const { safePath } = require("../utils/SafePath");
router.get("/fs/:id/files/download/:filename", async (req, res) => {
  const { id, filename } = req.params;
  const subPath = req.query.path || "";
  const volumePath = path.join(__dirname, "../volumes", id);
  try {
    const filePath = safePath(volumePath, subPath ? path.join(subPath, filename) : filename);
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) return res.status(400).json({ message: "Use /zip for directories" });
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    const stream = require("fs").createReadStream(filePath);
    stream.pipe(res);
  } catch (err) {
    res.status(404).json({ message: "File not found" });
  }
});
module.exports = router;
