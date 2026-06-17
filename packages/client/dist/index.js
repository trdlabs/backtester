// src/wire.ts
var CONTRACT_VERSION = "017.2";
var ARTIFACT_CONTRACT_VERSION = "022.1";
var BUNDLE_CONTRACT_VERSION = "019.1";
var HISTORICAL_DATA_CONTRACT_VERSION = "030.1";

// src/errors.ts
var BacktesterError = class extends Error {
  constructor(status, code, message, category, payload) {
    super(message);
    this.status = status;
    this.code = code;
    this.category = category;
    this.payload = payload;
    this.name = new.target.name;
  }
  status;
  code;
  category;
  payload;
};
var BacktesterValidationError = class extends BacktesterError {
};
var BacktesterConflictError = class extends BacktesterError {
};
var BacktesterNotFoundError = class extends BacktesterError {
};
var BacktesterAuthError = class extends BacktesterError {
};

// src/client.ts
var TERMINAL = /* @__PURE__ */ new Set([
  "completed",
  "failed",
  "canceled",
  "expired",
  "timed_out"
]);
var defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
var BacktesterClient = class {
  base;
  token;
  fetchImpl;
  constructor(opts) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }
  async request(method, path, body) {
    const init = {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...body !== void 0 ? { "content-type": "application/json" } : {}
      }
    };
    if (body !== void 0) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(`${this.base}${path}`, init);
    if (res.ok) return await res.json();
    return this.raise(res, path);
  }
  async raise(res, path) {
    let payload;
    try {
      payload = await res.json();
    } catch {
      payload = void 0;
    }
    const code = payload?.code ?? "error";
    const message = payload?.message ?? `backtester responded ${res.status} for ${path}`;
    const category = payload?.category;
    switch (res.status) {
      case 400:
        throw new BacktesterValidationError(res.status, code, message, category, payload);
      case 401:
        throw new BacktesterAuthError(res.status, code, message, category, payload);
      case 404:
        throw new BacktesterNotFoundError(res.status, code, message, category, payload);
      case 409:
        throw new BacktesterConflictError(res.status, code, message, category, payload);
      default:
        throw new BacktesterError(res.status, code, message, category, payload);
    }
  }
  getCapabilities() {
    return this.request("GET", "/v1/capabilities");
  }
  async listDatasets() {
    const body = await this.request("GET", "/v1/datasets");
    return body.datasets;
  }
  validateModule(req) {
    return this.request("POST", "/v1/modules/validate", req);
  }
  submitRun(req) {
    return this.request("POST", "/v1/runs", req);
  }
  getRunStatus(runId) {
    return this.request("GET", `/v1/runs/${encodeURIComponent(runId)}/status`);
  }
  /** Throws BacktesterConflictError (409) when the run has not produced a result yet. */
  getRunResult(runId) {
    return this.request("GET", `/v1/runs/${encodeURIComponent(runId)}/result`);
  }
  getArtifactManifest(runId) {
    return this.request("GET", `/v1/runs/${encodeURIComponent(runId)}/artifacts`);
  }
  readArtifact(runId, artifactId, opts = {}) {
    const q = new URLSearchParams();
    if (opts.offset !== void 0) q.set("offset", String(opts.offset));
    if (opts.limit !== void 0) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.request(
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}${qs ? `?${qs}` : ""}`
    );
  }
  cancelRun(runId) {
    return this.request("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`);
  }
  /** Poll status until terminal (or timeout). Returns the last status view either way. */
  async awaitCompletion(runId, opts = {}) {
    const intervalMs = opts.intervalMs ?? 500;
    const timeoutMs = opts.timeoutMs ?? 6e4;
    const sleep = opts.sleep ?? defaultSleep;
    const start = Date.now();
    for (; ; ) {
      const status = await this.getRunStatus(runId);
      if (TERMINAL.has(status.status)) return status;
      if (Date.now() - start > timeoutMs) return status;
      await sleep(intervalMs);
    }
  }
};

export { ARTIFACT_CONTRACT_VERSION, BUNDLE_CONTRACT_VERSION, BacktesterAuthError, BacktesterClient, BacktesterConflictError, BacktesterError, BacktesterNotFoundError, BacktesterValidationError, CONTRACT_VERSION, HISTORICAL_DATA_CONTRACT_VERSION };
