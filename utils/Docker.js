// ================================================
// FIXED: ks-wings/utils/Docker.js
// ================================================
// Only change: pull() now returns the real HTTP response stream (required by modem.followProgress)
// Everything else (version detection, modem, Container class, etc.) was already solid.

const http = require("node:http");
const { EventEmitter } = require("node:events");

class Docker {
  constructor(options = {}) {
    this.socketPath = options.socketPath || process.env.dockerSocket;
    this.apiVersion = null;
  }

  async _getApiVersion() {
    if (this.apiVersion) return this.apiVersion;
    try {
      const version = await this._rawRequest("GET", "/version");
      this.apiVersion = version.ApiVersion;
      return this.apiVersion;
    } catch {
      this.apiVersion = "1.44";
      return this.apiVersion;
    }
  }

  _rawRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const options = { socketPath: this.socketPath, path, method, headers: { "Content-Type": "application/json" } };
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data ? JSON.parse(data) : null);
            } else {
              reject(new Error(`Docker API Error: ${res.statusCode} - ${data}`));
            }
          } catch (e) {
            reject(new Error(`Parsing error: ${e.message}`));
          }
        });
      });
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async _request(method, path, body = null, expectJson = true) {
    const version = await this._getApiVersion();
    return new Promise((resolve, reject) => {
      const options = {
        socketPath: this.socketPath,
        path: `/v${version}${path}`,
        method,
        headers: { "Content-Type": "application/json" },
      };
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(expectJson && data ? JSON.parse(data) : data || null);
            } else {
              reject(new Error(`Docker API Error: ${res.statusCode} - ${data}`));
            }
          } catch (e) {
            reject(new Error(`Parsing error: ${e.message}`));
          }
        });
      });
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ==================== IMAGE PULL (FIXED) ====================
  async pull(imageName) {
    const version = await this._getApiVersion();
    return new Promise((resolve, reject) => {
      const options = {
        socketPath: this.socketPath,
        path: `/v${version}/images/create?fromImage=${encodeURIComponent(imageName)}`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      };

      const req = http.request(options, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res);                     // ← THIS IS THE FIX (return real stream)
        } else {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => reject(new Error(`Failed to pull image: ${res.statusCode} - ${data}`)));
        }
      });
      req.on("error", reject);
      req.end();
    });
  }

  get modem() {
    const self = this;
    return {
      followProgress(stream, onFinished, onProgress) {
        let allOutput = [];
        stream.on("data", (chunk) => {
          const lines = chunk.toString().split("\n").filter((l) => l.trim());
          for (const line of lines) {
            try {
              const data = JSON.parse(line);
              allOutput.push(data);
              if (onProgress) onProgress(data);
            } catch {}
          }
        });
        stream.on("end", () => {
          const last = allOutput[allOutput.length - 1];
          if (last && last.error) {
            onFinished(new Error(last.error), allOutput);
          } else {
            onFinished(null, allOutput);
          }
        });
        stream.on("error", (err) => onFinished(err, allOutput));
      },
    };
  }

  // ==================== REST OF CLASS (unchanged) ====================
  async ping() { return this._request("GET", "/_ping", null, false); }
  async info() { return this._request("GET", "/info"); }
  async version() { return this._request("GET", "/version"); }

  async listContainers(options = {}) { /* unchanged */ }
  getContainer(containerId) { return new Container(this, containerId); }
  async createContainer(config) { /* unchanged */ }

  async listImages(options = {}) { /* unchanged */ }

  async listNetworks() { return this._request("GET", "/networks"); }
  async createNetwork(config) { return this._request("POST", "/networks/create", config); }
  async removeNetwork(networkId) { return this._request("DELETE", `/networks/${networkId}`, null, false); }
}

class Container { /* unchanged - full original implementation */ }
class Exec { /* unchanged */ }

module.exports = Docker;
