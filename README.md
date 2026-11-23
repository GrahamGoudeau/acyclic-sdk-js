# acyclic-sdk (JavaScript)

An EHR agent springboard with no dependencies. Bring your own EHR credentials and your own model. You get:
- SMART Backend Services auth
- 13 FHIR R4 tools that already handle the differences between Epic, Oracle Health, athenahealth, MEDITECH and eClinicalWorks
- an agent loop with hard budgets
- telemetry that keeps patient data out of your logs

It runs in Node 20+ and browsers. Apache-2.0.

Try it first: **[agentsdk.acyclic.sh](https://agentsdk.acyclic.sh)** runs this SDK in your browser against vendor-compatible mock APIs with synthetic patients.

Also in [Go](https://github.com/GrahamGoudeau/acyclic-sdk-go) and [Rust](https://github.com/GrahamGoudeau/acyclic-sdk-rs). All three ports share one [spec](https://github.com/GrahamGoudeau/acyclic-sdk-spec).

## Install

```sh
npm install github:GrahamGoudeau/acyclic-sdk-js
```

## Quickstart (free sandbox, 30 seconds)

```js
import { connect, createSession, runAgent, openAICompatible, generateKeyPair } from "acyclic-sdk";

// 1. Register a sandbox app with a fresh key (real vendors: register in their developer portal).
const key = await generateKeyPair("RS384");
const reg = await (await fetch("https://sandbox.acyclic.sh/register", {
  method: "POST",
  body: JSON.stringify({ vendor: "epic", jwks: { keys: [key.publicJwk] } }),
})).json();

// 2. Connect. The token URL comes from the server's smart-configuration.
const ehr = await connect({
  vendor: "epic",
  baseUrl: reg.fhir_base_url,
  clientId: reg.client_id,
  privateKey: key.privateKey,
  kid: key.kid,
});

// 3. One session = one patient.
const patients = await (await fetch("https://sandbox.acyclic.sh/api/patients?vendor=epic")).json();
const session = createSession(ehr, { patient: patients[0].id });

// 4. Use the tools directly...
const labs = await session.call("get_labs_vitals", { code: "4548-4" }); // HbA1c
console.log(labs.result.items);

// ...or let a model drive them.
const out = await runAgent({
  ehr, session,
  model: openAICompatible({ baseUrl: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY, model: "deepseek/deepseek-v4.1-flash-1017" }),
  dataPolicy: "synthetic", // sandbox only. Real patient data needs "baa".
  prompt: "Summarize active problems and the HbA1c trend.",
});
console.log(out.text);
```

## Connect to a real EHR

| `vendor` | Auth | FHIR base | Notes |
|---|---|---|---|
| `epic` | signed JWT (RS384) | `https://{host}/{instance}/api/FHIR/R4` | Register a JWKS URL in Epic's developer portal |
| `oracle` | client secret or signed JWT | `https://fhir-ehr.cerner.com/r4/{tenant}` | System account in Oracle's code console |
| `athena` | client secret or signed JWT | `https://api.platform.athenahealth.com/fhir/r4` | Pass `practiceId` |
| `meditech` | client secret or signed JWT | `https://{hospital-host}/v1/uscore/R4` | One host per hospital |
| `ecw` | signed JWT | `https://fhir4.eclinicalworks.com/fhir/r4/{practiceCode}` | Server-side only (no CORS) |
| `generic` | signed JWT | any US Core server | Standard parameters, v2 scopes |

```js
const ehr = await connect({
  vendor: "oracle",
  baseUrl: process.env.EHR_BASE_URL,
  clientId: process.env.EHR_CLIENT_ID,
  clientSecret: process.env.EHR_CLIENT_SECRET, // or privateKey (PKCS#8 PEM, JWK or CryptoKey) + kid
  write: false,                                // true adds the note write scope
  telemetry: jsonTelemetry(),
});
```

Keys and secrets stay in memory. The SDK never writes them anywhere.

## Tools

Each tool acts on the session's one patient. Results are small flat objects ([projections](https://github.com/GrahamGoudeau/acyclic-sdk-spec/blob/main/projections.md)), not raw FHIR.

| Tool | What it returns |
|---|---|
| `find_patient`, `select_patient` | Find and bind a patient. Only available while the session is unbound |
| `get_patient` | Demographics: name, birth date, gender, MRN |
| `list_conditions` | Problem list (`active`, `resolved`, `all`) |
| `list_medications` | Medication orders |
| `list_allergies` | Allergies and reactions |
| `get_labs_vitals` | Labs or vitals, newest first. Filter by LOINC code and date |
| `list_encounters` | Visits, newest first |
| `list_appointments` | Upcoming appointments (athena uses its proprietary API; eCW has none) |
| `list_documents`, `read_document` | Clinical notes and their text (HTML is reduced to text) |
| `get_coverage` | Insurance on file |
| `create_note` | Saves a text note. Needs `allowWrites: true` and an `approve` callback (Epic and Oracle Health) |

```js
const session = createSession(ehr, {
  patient: id,
  allowWrites: true,
  approve: async ({ summary, args }) => askAHuman(summary, args.text), // return true to allow
});
session.definitions();                               // JSON Schema tool list for any model API
await session.call("create_note", { title, text });  // { ok, result } or { ok: false, error, code }
```

## Models

`openAICompatible` (OpenAI, Azure OpenAI, OpenRouter, vLLM, Ollama), `anthropic`, and `bedrock` (Converse API with SigV4 signing; no AWS SDK needed). All three use plain `fetch`.

## Data policy and HIPAA

`runAgent` refuses to start without `dataPolicy`:
- `"baa"`: real patient data. The model must be created with `coveredByBAA: true`, which is your statement that a BAA covers it. Bedrock under an AWS BAA is the common choice.
- `"synthetic"`: only sandbox hosts (`*.acyclic.sh`, Epic's and Oracle's public sandboxes, athena preview, localhost). Any other host throws.

Other safeguards:
- The session is bound to one patient. Tools drop any returned resource that belongs to someone else, and `read_document` refuses another patient's note.
- Writes are off by default. Each one needs `approve()` to return `true`. A declined write is not retried.
- Budgets stop runaway loops: `maxSteps` 8, `maxToolCalls` 20, `maxTokens` 60,000, `maxOutputTokens` 4,096 per call (reasoning models spend output tokens on hidden reasoning). `out.stop` says which one fired (`output_truncated` when a reply hit the output cap).

## Telemetry (OpenTelemetry compatible)

The SDK depends on no telemetry library. Pass a `telemetry` hook: `{ startSpan(name, attrs, parent), log(level, name, attrs), audit(record) }`.
- Span names and attributes follow OTel semantic conventions (`gen_ai.*`, `http.*`, `url.template`), listed in [telemetry.md](https://github.com/GrahamGoudeau/acyclic-sdk-spec/blob/main/telemetry.md).
- The SDK filters every attribute through an allow-list before your hook sees it.
- **Never recorded:** query strings, request and response bodies, raw resource ids, prompts, model output, tool arguments, and tokens. Patients appear only as `acyclic.patient_ref`, an HMAC of the id (set `telemetrySalt` to correlate across processes).
- `audit` receives one AuditEvent-shaped record per FHIR request, for your compliance store.

`jsonTelemetry()` writes JSON lines. Here is an OTel adapter:

```js
import { trace, context } from "@opentelemetry/api";
const tracer = trace.getTracer("acyclic-sdk");
const otel = {
  startSpan(name, attrs, parent) {
    const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
    const span = tracer.startSpan(name, { attributes: attrs }, ctx);
    return { context: span, setAttributes: (a) => span.setAttributes(a), end: (e) => { if (e) span.setStatus({ code: 2, message: e.type }); span.end(); } };
  },
  log(level, name, attrs) { trace.getActiveSpan()?.addEvent(name, { level, ...attrs }); },
  audit(record) { auditSink.write(record); }, // your retention store
};
```

For local debugging, `connect({ inspect })` receives every raw request and response. It sees patient data, so keep it out of production.

## Persistence

Pass `store` (`{ load(id), save(id, messages), delete(id) }`) and a `conversationId` to `runAgent` to resume conversations. `memoryStore()` is included. Postgres:

```sql
CREATE TABLE acyclic_conversations (
  id       text PRIMARY KEY,
  messages jsonb NOT NULL,
  updated  timestamptz NOT NULL DEFAULT now()
);
```

Stored conversations contain patient data. Encrypt at rest, set a retention period, and support deletion.

## Why it's built this way

Each item is a common EHR-integration mistake and how this SDK avoids it:

- **Following a paging link to another host** sends your bearer token there. The client refuses any URL outside the FHIR base's origin.
- **Logging request URLs** leaks names and birth dates from search parameters. Telemetry carries a URL template (`/Patient/{id}`) and never a query string.
- **Handing raw Bundles to a model** costs 10 to 50 times the tokens and breaks HIPAA's minimum-necessary rule. Tools return small projections.
- **Trusting the server to scope results to one patient.** Every result is checked against the bound patient.
- **Unbounded agent loops.** Steps, tool calls and tokens all have hard caps.
- **Retrying POSTs.** Only GETs are retried, which avoids duplicate notes.
- **Ignoring `Retry-After`.** 429 and 503 responses wait the time the server asks for, then fall back to jittered exponential backoff.
- **Asking for wildcard scopes.** Oracle, athena, MEDITECH and eCW reject them, so the SDK lists each resource.
- **Parsing `expires_in` as a number only.** athena's documented sample sends a string.
- **Error messages that include server diagnostics.** Diagnostics can echo search values, so they stay on `error.outcome` for your own code to read.
- **Keys on disk or in env dumps.** Keys load into a non-extractable `CryptoKey` and stay in memory.
- **One code path per vendor.** All vendor differences live in [`src/vendors.js`](src/vendors.js), each with a cited source in [vendors.md](https://github.com/GrahamGoudeau/acyclic-sdk-spec/blob/main/vendors.md).

## Vendor quirks handled

- **Epic:**
  - Observation searches send `code` or `category`, never both.
  - Notes default to `category=clinical-note` and are read from HTML Binaries.
  - `create_note` files under the latest encounter.
  - A "no known allergies" resource is passed through rather than read as an empty result.
- **Oracle Health:**
  - Appointment dates carry a time.
  - Notes use `text/plain;charset=utf-8` and `context.period.end`.
  - Creates return an empty body, so the id comes from `Location`.
- **athenahealth:**
  - Requests carry `ah-practice` and `intent=order`.
  - Appointments come from `/v1/{practiceid}`.
  - `expires_in` arrives as a string.
- **MEDITECH:** SMART v2 scopes only, and medication status values are mapped.
- **eClinicalWorks:** medication searches carry `intent=order`, and there is no Appointment API.

## Develop

```sh
npm test                                            # projection fixtures
SANDBOX_URL=https://sandbox.acyclic.sh npm test     # plus end-to-end against all five mocks
```

## License

Apache-2.0. Copyright 2026 Acyclic LLC. Not affiliated with or endorsed by Epic Systems, Oracle, athenahealth, MEDITECH or eClinicalWorks.
