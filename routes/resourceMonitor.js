// Add this file to ks-wings/routes/resourceMonitor.js
const express = require('express');
const router = express.Router();
const os = require('os');
const fsPromises = require('fs/promises');
const osut = require('os-utils');

async function getCpuUsage() {
  return new Promise((resolve) => {
    osut.cpuUsage((v) => {
      resolve((v * 100).toFixed(2));
    });
  });
}

router.get('/resourceMonitor', async (req, res) => {
  const totalRam = os.totalmem() / (1024 ** 3); // GB
  const freeRam = os.freemem() / (1024 ** 3);
  const usedRam = totalRam - freeRam;
  const ramPercent = (usedRam / totalRam) * 100;

  const cpuPercent = await getCpuUsage();

  let disk = { used: 0, total: 0, percent: 0 };
  try {
    const stats = await fsPromises.statfs('/');
    const totalDisk = (stats.blocks * stats.bsize) / (1024 ** 3); // GB
    const freeDisk = (stats.bfree * stats.bsize) / (1024 ** 3);
    const usedDisk = totalDisk - freeDisk;
    disk = { used: usedDisk, total: totalDisk, percent: (usedDisk / totalDisk) * 100 };
  } catch (error) {
    console.error('Error getting disk usage:', error);
  }

  res.status(200).json({
    ram: { used: usedRam.toFixed(1), total: totalRam.toFixed(1), percent: ramPercent.toFixed(0) },
    cpu: { percent: cpuPercent },
    disk: { used: disk.used.toFixed(1), total: disk.total.toFixed(1), percent: disk.percent.toFixed(0) }
  });
});

module.exports = router;
