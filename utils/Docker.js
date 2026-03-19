const http = require("node:http");

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
          resolve(res);
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
          if (last && last.error) onFinished(new Error(last.error), allOutput);
          else onFinished(null, allOutput);
        });
        stream.on("error", (err) => onFinished(err, allOutput));
      },
    };
  }

  async createContainer(config) {
    const name = config.name;
    delete config.name;
    const query = name ? `?name=${encodeURIComponent(name)}` : "";
    const response = await this._request("POST", `/containers/create${query}`, config);
    if (!response?.Id) {
      throw new Error(`Container creation failed: ${JSON.stringify(response)}`);
    }
    return new Container(this, response.Id);
  }

  async listContainers(options = {}) {
    const qs = new URLSearchParams();
    if (options.all !== undefined) qs.set("all", options.all ? "1" : "0");
    const query = qs.toString() ? "?" + qs.toString() : "";
    return this._request("GET", `/containers/json${query}`);
  }

  async listImages(options = {}) {
    return this._request("GET", "/images/json");
  }

  async listNetworks() { return this._request("GET", "/networks"); }
  async createNetwork(config) { return this._request("POST", "/networks/create", config); }
  async removeNetwork(networkId) { return this._request("DELETE", `/networks/${networkId}`, null, false); }
  async ping() { return this._request("GET", "/_ping", null, false); }
  async info() { return this._request("GET", "/info"); }
  async version() { return this._request("GET", "/version"); }

  getContainer(containerId) { return new Container(this, containerId); }
}

class Container {
  constructor(docker, id) {
    this.docker = docker;
    this.id = id;
  }

  inspect(callback) {
    const promise = this.docker._request("GET", `/containers/${this.id}/json`);
    if (typeof callback === "function") {
      promise.then(r => callback(null, r)).catch(e => callback(e));
      return;
    }
    return promise;
  }

  async start() {
    return this.docker._request("POST", `/containers/${this.id}/start`, null, false);
  }

  async stop(options = {}) {
    let path = `/containers/${this.id}/stop`;
    if (options.t !== undefined) path += `?t=${options.t}`;
    return this.docker._request("POST", path, null, false);
  }

  async restart(options = {}) {
    let path = `/containers/${this.id}/restart`;
    if (options.t !== undefined) path += `?t=${options.t}`;
    return this.docker._request("POST", path, null, false);
  }

  async kill(options = {}) {
    let path = `/containers/${this.id}/kill`;
    if (options.signal) path += `?signal=${options.signal}`;
    return this.docker._request("POST", path, null, false);
  }

  async pause() {
    return this.docker._request("POST", `/containers/${this.id}/pause`, null, false);
  }

  async unpause() {
    return this.docker._request("POST", `/containers/${this.id}/unpause`, null, false);
  }

  async remove(options = {}) {
    let path = `/containers/${this.id}`;
    const params = [];
    if (options.force) params.push("force=1");
    if (options.v) params.push("v=1");
    if (params.length) path += "?" + params.join("&");
    return this.docker._request("DELETE", path, null, false);
  }

  async stats(options = {}) {
    const qs = new URLSearchParams({ stream: options.stream !== false ? "1" : "0" }).toString();
    const version = await this.docker._getApiVersion();
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: this.docker.socketPath,
        path: `/v${version}/containers/${this.id}/stats?${qs}`,
        method: "GET"
      }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res);
        else {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => reject(new Error(`Stats error: ${res.statusCode} - ${data}`)));
        }
      });
      req.on("error", reject);
      req.end();
    });
  }

  async logs(options = {}) {
    const qs = new URLSearchParams({
      follow: options.follow ? "1" : "0",
      stdout: options.stdout !== false ? "1" : "0",
      stderr: options.stderr !== false ? "1" : "0",
      tail: options.tail !== undefined ? String(options.tail) : "all",
      timestamps: options.timestamps ? "1" : "0"
    }).toString();
    const version = await this.docker._getApiVersion();
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: this.docker.socketPath,
        path: `/v${version}/containers/${this.id}/logs?${qs}`,
        method: "GET"
      }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res);
        else {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => reject(new Error(`Logs error: ${res.statusCode} - ${data}`)));
        }
      });
      req.on("error", reject);
      req.end();
    });
  }

  async exec(options) {
    const response = await this.docker._request("POST", `/containers/${this.id}/exec`, options);
    if (!response?.Id) {
      throw new Error(`Exec creation failed: ${JSON.stringify(response)}`);
    }
    return new Exec(this.docker, response.Id);
  }

  async attach(options = {}) {
    const qs = new URLSearchParams({
      stream: "1",
      stdout: "1",
      stderr: "1",
      stdin: options.stdin ? "1" : "0"
    }).toString();
    const version = await this.docker._getApiVersion();
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: this.docker.socketPath,
        path: `/v${version}/containers/${this.id}/attach?${qs}`,
        method: "GET"
      }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res);
        else {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => reject(new Error(`Attach error: ${res.statusCode} - ${data}`)));
        }
      });
      req.on("error", reject);
      req.end();
    });
  }
}

class Exec {
  constructor(docker, id) {
    this.docker = docker;
    this.id = id;
  }

  async start(options = {}) {
    return this.docker._request("POST", `/exec/${this.id}/start`, options, false);
  }

  async inspect() {
    return this.docker._request("GET", `/exec/${this.id}/json`);
  }
}

module.exports = Docker;
