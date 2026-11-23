// Minimal FHIR R4 client: auth, retries, paging, OperationOutcome errors,
// and telemetry that never carries query strings, bodies or ids.

import { tokenSource } from "./auth.js";
import { guard } from "./telemetry.js";
import { sleep } from "./util.js";

export class FhirError extends Error {
  constructor(status, resourceType, outcome) {
    const code = outcome?.issue?.[0]?.code;
    super(`FHIR ${status} on ${resourceType}${code ? ` (${code})` : ""}`);
    this.status = status;
    this.resourceType = resourceType;
    this.code = code;
    // Kept on the error for your own handling; never logged by the SDK.
    // Diagnostics can echo search values.
    this.outcome = outcome;
    this.type = code ? `OperationOutcome:${code}` : String(status);
  }
}

export class FhirClient {
  // opts: { vendor, baseUrl, tokenUrl, auth: {...}, telemetry, fetch, maxRetries, inspect }
  // inspect({ method, url, status, ms, requestBody, responseBody }) is a local
  // debugging hook (the sandbox UI uses it). It sees raw data: your code, your rules.
  constructor(opts) {
    this.vendor = opts.vendor;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.base = new URL(this.baseUrl + "/");
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.t = guard(opts.telemetry);
    this.maxRetries = opts.maxRetries ?? 3;
    this.inspect = opts.inspect;
    this.headers = opts.headers ?? {};
    this.getToken = tokenSource({ ...opts.auth, tokenUrl: opts.tokenUrl, fetch: this.fetch, telemetry: this.t, vendor: this.vendor });
  }

  // path: "Patient/123" or "Observation"; params: object or URLSearchParams.
  async request(method, path, { params, body, accept = "application/fhir+json", parent, resourceType, raw = false } = {}) {
    const url = path.startsWith("http") ? new URL(path) : new URL(path, this.base);
    if (url.origin !== this.base.origin) throw new Error(`refusing to send credentials to ${url.origin}`);
    if (params) for (const [k, v] of params instanceof URLSearchParams ? params : Object.entries(params)) {
      if (v === undefined || v === null) continue;
      for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
    }
    resourceType ??= path.split(/[/?]/)[0];
    const span = this.t.startSpan(`${method} ${resourceType}`, {
      "http.request.method": method, "server.address": url.hostname, "url.template": this.template(url),
      "fhir.resource_type": resourceType, "acyclic.vendor": this.vendor,
    }, parent);

    let retries = 0, refreshed = false;
    try {
      for (;;) {
        const token = await this.getToken({ force: refreshed === "now" });
        if (refreshed === "now") refreshed = true;
        const headers = { accept, authorization: `Bearer ${token}`, ...this.headers };
        if (body !== undefined) headers["content-type"] = "application/fhir+json";
        const started = Date.now();
        let res;
        try {
          res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        } catch (e) {
          if (retries < this.maxRetries && method === "GET") { retries++; await sleep(backoff(retries)); continue; }
          e.type = "transport";
          throw e;
        }
        if (res.status === 401 && !refreshed) { refreshed = "now"; continue; }
        if ((res.status === 429 || res.status === 503) && retries < this.maxRetries && method === "GET") {
          retries++;
          this.t.log("warn", "fhir.retry", { "http.response.status_code": res.status, "acyclic.retry_count": retries, "fhir.resource_type": resourceType });
          await sleep(retryAfter(res) ?? backoff(retries));
          continue;
        }
        const text = await res.text();
        this.inspect?.({ method, url: url.toString(), status: res.status, ms: Date.now() - started, requestBody: body, responseBody: text, location: res.headers.get("location") });
        span.setAttributes({ "http.response.status_code": res.status, "acyclic.retry_count": retries || undefined });
        let json;
        if (!raw || !res.ok) { try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; } }
        if (!res.ok) throw new FhirError(res.status, resourceType, json?.resourceType === "OperationOutcome" ? json : undefined);
        const out = raw ? { text, contentType: res.headers.get("content-type") || "", status: res.status } : json ?? {};
        if (!raw && res.headers.get("location")) out.__location = res.headers.get("location");
        span.end();
        return out;
      }
    } catch (e) {
      span.setAttributes({ "error.type": e.type ?? "error" });
      span.end(e);
      throw e;
    }
  }

  read(type, id, opts) { return this.request("GET", `${type}/${encodeURIComponent(id)}`, { ...opts, resourceType: type }); }

  create(type, resource, opts) { return this.request("POST", type, { ...opts, body: resource, resourceType: type }); }

  // Follows Bundle next links (same origin only) until limit entries.
  // Returns { resources, truncated }. search.mode=outcome entries are dropped.
  async search(type, params, { limit = 50, parent } = {}) {
    const resources = [];
    let page = await this.request("GET", type, { params, parent, resourceType: type });
    for (let pages = 1; ; pages++) {
      for (const e of page.entry || []) {
        if (e.search?.mode === "outcome" || e.resource?.resourceType === "OperationOutcome") continue;
        if (e.resource?.resourceType !== type) continue; // _include results and similar
        resources.push(e.resource);
      }
      const next = page.link?.find((l) => l.relation === "next")?.url;
      if (pages >= MAX_PAGES) return { resources: resources.slice(0, limit), truncated: true }; // a server looping its next link
      if (resources.length >= limit || !next) {
        return { resources: resources.slice(0, limit), truncated: resources.length > limit || (resources.length >= limit && !!next) };
      }
      page = await this.request("GET", next, { parent, resourceType: type });
    }
  }

  // "/api/FHIR/R4/Patient/{id}" style template: never ids, never query.
  template(url) {
    // Keep resource types, $operations and a few fixed path words; every
    // other segment could be an id, even an all-lowercase one.
    const basePath = this.base.pathname.replace(/\/$/, "");
    const inBase = url.pathname.startsWith(basePath + "/");
    const parts = (inBase ? url.pathname.slice(basePath.length) : url.pathname).split("/").filter(Boolean);
    const t = parts.map((p) => (/^[A-Z][A-Za-z]+$/.test(p) || /^\$[a-z-]+$/.test(p) || FIXED.has(p) ? p : "{id}"));
    return (inBase ? basePath : "") + "/" + t.join("/");
  }
}

const FIXED = new Set(["_history", "_search", "v1", "patients", "appointments"]);
const MAX_PAGES = 100;

function retryAfter(res) {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.min(s * 1000, 30_000);
  const d = Date.parse(h) - Date.now();
  return Number.isFinite(d) ? Math.max(0, Math.min(d, 30_000)) : undefined;
}

// Exponential with full jitter: 0..(250ms * 2^n), capped at 8s.
const backoff = (n) => Math.random() * Math.min(8000, 250 * 2 ** n);
