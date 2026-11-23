// Telemetry hooks. Rules: spec/telemetry.md. No OTel dependency: a Telemetry is
//   { startSpan(name, attrs, parent) -> { setAttributes(attrs), end(error?) },
//     log(level, name, attrs), audit(record) }
// The SDK filters every attribute through ALLOWED before it reaches a hook.

import { randomId } from "./util.js";

export const ALLOWED = new Set([
  "gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.request.model",
  "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.response.finish_reasons",
  "gen_ai.tool.name", "gen_ai.tool.call.id", "gen_ai.conversation.id",
  "http.request.method", "http.response.status_code", "server.address", "url.template",
  "fhir.resource_type", "fhir.result_count", "acyclic.vendor", "acyclic.patient_ref",
  "acyclic.retry_count", "acyclic.debug.arg_keys", "acyclic.debug.response_bytes", "error.type",
]);

export function clean(attrs = {}) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) if (ALLOWED.has(k) && v !== undefined) out[k] = v;
  return out;
}

const NOOP_SPAN = { setAttributes() {}, end() {}, context: undefined };

export const noTelemetry = {
  startSpan: () => NOOP_SPAN,
  log() {},
  audit() {},
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// JSON lines, one object per finished span, log event or audit record.
// write defaults to console.log; pass your own sink (a file, a queue).
export function jsonTelemetry({ write = (line) => console.log(line), level = "info", audit = true } = {}) {
  const min = LEVELS[level] ?? 20;
  return {
    startSpan(name, attrs, parent) {
      const ctx = { traceId: parent?.traceId ?? randomId(), spanId: randomId().slice(0, 16) };
      const start = Date.now();
      const a = { ...attrs };
      return {
        context: ctx,
        setAttributes(more) { Object.assign(a, more); },
        end(error) {
          write(JSON.stringify({
            kind: "span", name, trace_id: ctx.traceId, span_id: ctx.spanId, parent_span_id: parent?.spanId,
            start: new Date(start).toISOString(), duration_ms: Date.now() - start,
            status: error ? "error" : "ok", attributes: a,
          }));
        },
      };
    },
    log(lvl, name, attrs) {
      if ((LEVELS[lvl] ?? 20) >= min) write(JSON.stringify({ kind: "log", time: new Date().toISOString(), level: lvl, name, attributes: attrs }));
    },
    audit(record) {
      if (audit) write(JSON.stringify({ kind: "audit", ...record }));
    },
  };
}

// Fan out to several sinks, e.g. [otel, jsonTelemetry()].
export function multiTelemetry(list) {
  return {
    startSpan(name, attrs, parent) {
      const spans = list.map((t, i) => t.startSpan(name, attrs, parent?.parts?.[i] ?? parent));
      return {
        context: spans[0]?.context, parts: spans.map((s) => s.context),
        setAttributes: (m) => spans.forEach((s) => s.setAttributes(m)),
        end: (e) => spans.forEach((s) => s.end(e)),
      };
    },
    log: (...a) => list.forEach((t) => t.log(...a)),
    audit: (r) => list.forEach((t) => t.audit(r)),
  };
}

// Internal wrapper: enforces the allow-list and keeps hook errors from
// breaking a request.
export function guard(t = noTelemetry) {
  const safe = (f) => { try { return f(); } catch { return undefined; } };
  return {
    startSpan(name, attrs, parent) {
      const s = safe(() => t.startSpan(name, clean(attrs), parent?.raw)) || NOOP_SPAN;
      return {
        raw: s.context ?? s,
        setAttributes: (a) => safe(() => s.setAttributes(clean(a))),
        end: (e) => safe(() => s.end(e ? { type: e.type ?? "error" } : undefined)),
      };
    },
    log: (l, n, a) => safe(() => t.log(l, n, clean(a))),
    audit: (r) => safe(() => t.audit(r)),
  };
}

// HMAC-SHA256(salt, id) -> "p_" + 16 hex chars. Salt: config.telemetrySalt,
// else random per process (refs then match within one process only).
let processSalt;
export async function patientRef(id, salt) {
  if (!id) return undefined;
  salt ??= processSalt ??= randomId();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id)));
  return "p_" + [...sig.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
