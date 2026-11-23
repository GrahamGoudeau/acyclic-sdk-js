// acyclic-sdk: EHR agent springboard. Zero dependencies; Node 20+ and browsers.

import { FhirClient } from "./fhir.js";
import { VENDORS } from "./vendors.js";

export { FhirClient, FhirError } from "./fhir.js";
export { createSession, TOOL_SPECS, ToolError } from "./tools.js";
export { runAgent, memoryStore, DEFAULT_SYSTEM, SANDBOX_HOSTS } from "./agent.js";
export { openAICompatible, anthropic, bedrock } from "./models.js";
export { jsonTelemetry, noTelemetry, multiTelemetry, patientRef, ALLOWED as TELEMETRY_KEYS } from "./telemetry.js";
export { generateKeyPair, importPrivateKey, clientAssertion, AuthError } from "./auth.js";
export * as projections from "./projections.js";
export { VENDORS };

// connect({
//   vendor: "epic" | "oracle" | "athena" | "meditech" | "ecw" | "generic" | profile,
//   baseUrl,                      FHIR R4 base
//   tokenUrl?,                    default: from {baseUrl}/.well-known/smart-configuration
//   clientId,
//   privateKey?, kid?, alg?,      private_key_jwt (RS384 default)
//   clientSecret?,                client_secret_basic
//   scopes?, write?,              default: the vendor's read scopes (+ note write if write)
//   practiceId?,                  athena
//   telemetry?, fetch?, inspect?, headers?
// })
export async function connect(cfg) {
  const vendor = typeof cfg.vendor === "string" ? VENDORS[cfg.vendor] : cfg.vendor;
  if (!vendor) throw new Error(`unknown vendor ${cfg.vendor}; one of ${Object.keys(VENDORS).join(", ")}`);
  if (!cfg.baseUrl) throw new Error("baseUrl is required");
  if (!cfg.clientId) throw new Error("clientId is required");
  const f = cfg.fetch ?? ((...a) => fetch(...a));
  const tokenUrl = cfg.tokenUrl ?? (await discover(cfg.baseUrl, f));
  const fhir = new FhirClient({
    vendor: vendor.name, baseUrl: cfg.baseUrl, tokenUrl, telemetry: cfg.telemetry, fetch: f, inspect: cfg.inspect, headers: cfg.headers,
    auth: {
      method: cfg.auth ?? vendor.auth, clientId: cfg.clientId, clientSecret: cfg.clientSecret,
      privateKey: cfg.privateKey, kid: cfg.kid, alg: cfg.alg,
      scopes: cfg.scopes ?? vendor.scopes({ write: !!cfg.write }),
    },
  });
  return { vendor, fhir, clientId: cfg.clientId, practiceId: cfg.practiceId, telemetry: cfg.telemetry, tokenUrl };
}

async function discover(baseUrl, f) {
  const res = await f(`${baseUrl.replace(/\/$/, "")}/.well-known/smart-configuration`, { headers: { accept: "application/json" } });
  const j = res.ok ? await res.json().catch(() => ({})) : {};
  if (!j.token_endpoint) throw new Error("no tokenUrl given and smart-configuration has no token_endpoint");
  return j.token_endpoint;
}
