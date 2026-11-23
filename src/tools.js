// The tool layer: JSON Schema definitions plus handlers bound to one session
// and one patient. Works without the agent loop: definitions() for any model
// API, call(name, args) to execute.

import { SPEC } from "./spec.js";
import * as P from "./projections.js";
import { base64ToText } from "./util.js";
import { guard, patientRef } from "./telemetry.js";

export const TOOL_SPECS = SPEC.tools;

export class ToolError extends Error {
  constructor(message, type = "tool_error") { super(message); this.type = type; }
}

const sortDesc = (key) => (a, b) => {
  const x = a[key], y = b[key];
  if (x === y) return 0;
  if (x === undefined) return 1;
  if (y === undefined) return -1;
  return x < y ? 1 : x > y ? -1 : 0;
};

// Reference checks keep one session on one patient even if a server returns
// more than it was asked for.
function belongsTo(resource, patientId) {
  const r = resource.subject?.reference ?? resource.patient?.reference ??
    resource.beneficiary?.reference ?? resource.participant?.find((p) => p.actor?.reference?.startsWith("Patient/"))?.actor?.reference;
  return !r || r === `Patient/${patientId}` || r.endsWith(`/Patient/${patientId}`);
}

// session opts:
//   patient        bind now (else the model must find_patient + select_patient)
//   allowWrites    false by default
//   approve        async ({ tool, args, summary }) => boolean, required for writes
//   purposeOfUse   audit field, default "TREAT"
//   telemetrySalt  HMAC salt for acyclic.patient_ref
//   onToolResult   ({ name, args, result }) your own hook; sees raw data
export function createSession(ehr, opts = {}) {
  const t = guard(ehr.telemetry);
  let patientId = opts.patient;
  let pref;
  const allowWrites = !!opts.allowWrites;
  const purpose = opts.purposeOfUse ?? "TREAT";
  let runId = opts.runId;
  const vendor = ehr.vendor;

  const need = () => { if (!patientId) throw new ToolError("no patient selected; call find_patient then select_patient", "no_patient"); return patientId; };

  async function audit(action, resourceType, status, tool) {
    t.audit({
      // 0 means the request never got an answer (transport failure): serious.
      time: new Date().toISOString(), action, outcome: status > 0 && status < 400 ? "0" : status >= 400 && status < 500 ? "4" : "8",
      vendor: vendor.name, resource_type: resourceType, patient_ref: pref ??= await patientRef(patientId, opts.telemetrySalt),
      agent_run: runId, tool, purpose_of_use: purpose, client_id: ehr.clientId, status,
    });
  }

  async function search(type, params, limit, tool, parent) {
    const pid = need();
    const p = vendor.searchParams?.(type, { ...params }, ehr) ?? params;
    try {
      const out = await ehr.fhir.search(type, p, { limit, parent });
      await audit("R", type, 200, tool);
      out.resources = out.resources.filter((r) => belongsTo(r, pid));
      return out;
    } catch (e) {
      await audit("R", type, e.status ?? 0, tool);
      throw e;
    }
  }

  const list = (items, truncated) => ({ items, total: items.length, truncated: !!truncated });
  const dateGe = (since) => (since ? `ge${since}` : undefined);

  const handlers = {
    async find_patient(a, ctx) {
      if (!a.identifier && !a.family) throw new ToolError("give identifier, or family name (with given and/or birthdate)", "bad_args");
      const params = vendor.searchParams?.("Patient", { identifier: a.identifier, family: a.family, given: a.given, birthdate: a.birthdate }, ehr);
      const out = await ehr.fhir.search("Patient", params, { limit: 10, parent: ctx.span });
      return list(out.resources.map(P.patient), out.truncated);
    },
    async select_patient(a, ctx) {
      if (patientId) throw new ToolError("session already bound to a patient", "already_bound");
      const r = await ehr.fhir.read("Patient", a.patient_id, { parent: ctx.span });
      patientId = r.id;
      pref = await patientRef(patientId, opts.telemetrySalt);
      await audit("R", "Patient", 200, "select_patient");
      return P.patient(r);
    },
    async get_patient(_a, ctx) {
      const r = await ehr.fhir.read("Patient", need(), { parent: ctx.span });
      await audit("R", "Patient", 200, "get_patient");
      return P.patient(r);
    },
    async list_conditions(a, ctx) {
      const s = a.status ?? "active";
      const out = await search("Condition", { patient: need(), "clinical-status": s === "all" ? undefined : s }, 100, "list_conditions", ctx.span);
      return list(out.resources.map(P.condition), out.truncated);
    },
    async list_medications(a, ctx) {
      const s = a.status ?? "active";
      const out = await search("MedicationRequest", { patient: need(), status: s === "all" ? undefined : s }, 100, "list_medications", ctx.span);
      return list(out.resources.map(P.medication), out.truncated);
    },
    async list_allergies(_a, ctx) {
      const out = await search("AllergyIntolerance", { patient: need() }, 100, "list_allergies", ctx.span);
      return list(out.resources.map(P.allergy), out.truncated);
    },
    async get_labs_vitals(a, ctx) {
      const limit = a.limit ?? 20;
      const out = await search("Observation", {
        patient: need(), category: a.category ?? "laboratory",
        code: a.code ? `http://loinc.org|${a.code}` : undefined, date: dateGe(a.since), _sort: "-date",
      }, limit, "get_labs_vitals", ctx.span);
      return list(out.resources.map(P.observation).sort(sortDesc("effective")), out.truncated);
    },
    async list_encounters(a, ctx) {
      const out = await search("Encounter", { patient: need(), date: dateGe(a.since), _sort: "-date" }, a.limit ?? 10, "list_encounters", ctx.span);
      return list(out.resources.map(P.encounter).sort(sortDesc("start")), out.truncated);
    },
    async list_appointments(a, ctx) {
      const since = a.since ?? new Date().toISOString().slice(0, 10);
      const date = [`ge${since}`, a.until ? `le${a.until}` : undefined].filter(Boolean);
      const out = await search("Appointment", { patient: need(), date }, 50, "list_appointments", ctx.span);
      return list(out.resources.map(P.appointment).sort((x, y) => ((x.start ?? "~") < (y.start ?? "~") ? -1 : (x.start ?? "~") > (y.start ?? "~") ? 1 : 0)), out.truncated);
    },
    async list_documents(a, ctx) {
      const out = await search("DocumentReference", { patient: need(), date: dateGe(a.since), _sort: "-date" }, a.limit ?? 10, "list_documents", ctx.span);
      return list(out.resources.map(P.document).sort(sortDesc("date")), out.truncated);
    },
    async read_document(a, ctx) {
      const pid = need();
      const doc = await ehr.fhir.read("DocumentReference", a.document_id, { parent: ctx.span });
      if (!belongsTo(doc, pid)) { await audit("R", "DocumentReference", 403, "read_document"); throw new ToolError("document belongs to a different patient", "wrong_patient"); }
      await audit("R", "DocumentReference", 200, "read_document");
      const att = (doc.content || []).map((c) => c.attachment).find((x) => /text\/(plain|html)/.test(x?.contentType || "")) ?? doc.content?.[0]?.attachment;
      if (!att) throw new ToolError("document has no content", "no_content");
      let text, ct = att.contentType;
      if (att.data) text = base64ToText(att.data);
      else if (att.url) {
        const bin = await ehr.fhir.request("GET", att.url, { accept: vendor.binaryAccept ?? "application/fhir+json", raw: true, parent: ctx.span, resourceType: "Binary" });
        await audit("R", "Binary", bin.status, "read_document");
        if (/json/.test(bin.contentType)) {
          const b = JSON.parse(bin.text);
          text = b.data ? base64ToText(b.data) : "";
          ct = b.contentType ?? ct;
        } else { text = bin.text; ct = bin.contentType || ct; }
      } else throw new ToolError("attachment has neither data nor url", "no_content");
      if (!/^text\//.test(ct || "text/plain")) throw new ToolError(`unsupported content type ${ct}`, "unsupported_content");
      return P.documentText(doc, text, ct, a.max_chars ?? 4000);
    },
    async get_coverage(_a, ctx) {
      const out = await search("Coverage", { patient: need() }, 20, "get_coverage", ctx.span);
      return list(out.resources.map(P.coverage), out.truncated);
    },
    async create_note(a, ctx) {
      const pid = need();
      if (typeof a.title !== "string" || typeof a.text !== "string" || !a.text.trim()) throw new ToolError("create_note needs title and text strings", "bad_args");
      if (!allowWrites) { t.log("warn", "write.denied", { "gen_ai.tool.name": "create_note" }); throw new ToolError("writes are disabled for this session", "writes_disabled"); }
      if (!opts.approve) throw new ToolError("writes need an approve callback", "no_approver");
      const ok = await opts.approve({ tool: "create_note", args: a, summary: `Save note "${a.title}" (${a.text.length} chars) to the chart` });
      if (!ok) { t.log("info", "write.denied", { "gen_ai.tool.name": "create_note" }); throw new ToolError("a person declined this write", "declined"); }
      t.log("info", "write.approved", { "gen_ai.tool.name": "create_note" });
      const resource = vendor.prepareNote ? await vendor.prepareNote(pid, a, ehr, ctx) : defaultNote(pid, a);
      try {
        const created = await ehr.fhir.create("DocumentReference", resource, { parent: ctx.span });
        await audit("C", "DocumentReference", 201, "create_note");
        const id = created.id ?? created.__location?.match(/DocumentReference\/([^/]+)/)?.[1];
        return P.document({ ...resource, ...created, id });
      } catch (e) { await audit("C", "DocumentReference", e.status ?? 0, "create_note"); throw e; }
    },
  };

  return {
    get patientId() { return patientId; },
    get runId() { return runId; },
    set runId(v) { runId ??= v; }, // runAgent fills it in for audit records
    // Tool definitions for a model API. Unbound-only tools vanish once bound;
    // write tools appear only when writes are allowed.
    definitions() {
      return TOOL_SPECS.filter((s) => (s.kind !== "write" || allowWrites) && !(s.unbound_only && patientId) && (vendor.supports?.(s.name) ?? true))
        .map((s) => ({ name: s.name, description: s.description, input_schema: s.input_schema }));
    },
    async call(name, args = {}, { callId, parent } = {}) {
      const span = t.startSpan(`execute_tool ${name}`, {
        "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "gen_ai.tool.call.id": callId,
        "acyclic.vendor": vendor.name, "acyclic.patient_ref": pref,
      }, parent);
      try {
        const override = vendor.tools?.[name];
        const h = override
          ? async (a, ctx) => {
              const out = await override(a, { ehr, patientId: need(), span: ctx.span });
              await audit("R", name === "list_appointments" ? "Appointment" : "Unknown", 200, name);
              return out;
            }
          : handlers[name];
        if (!h || !this.definitions().some((d) => d.name === name)) throw new ToolError(`tool ${name} is not available`, "unknown_tool");
        checkArgs(name, args ?? {});
        const result = await h(args ?? {}, { span });
        if (pref) span.setAttributes({ "acyclic.patient_ref": pref });
        if (Array.isArray(result?.items)) span.setAttributes({ "fhir.result_count": result.items.length });
        opts.onToolResult?.({ name, args, result });
        span.end();
        return { ok: true, result };
      } catch (e) {
        span.setAttributes({ "error.type": e.type ?? "error" });
        span.end(e);
        return { ok: false, error: e.message, code: e.code ?? e.type };
      }
    },
  };
}

// Required arguments and string types from the tool's JSON Schema.
function checkArgs(name, args) {
  const spec = TOOL_SPECS.find((s) => s.name === name)?.input_schema;
  if (!spec) return;
  if (typeof args !== "object" || Array.isArray(args)) throw new ToolError("arguments must be an object", "bad_args");
  for (const k of spec.required ?? []) if (args[k] === undefined || args[k] === null || args[k] === "") throw new ToolError(`${k} is required`, "bad_args");
  for (const [k, v] of Object.entries(args)) {
    const want = spec.properties?.[k]?.type;
    if (want === "string" && typeof v !== "string") throw new ToolError(`${k} must be a string`, "bad_args");
    if (want === "integer" && !Number.isInteger(v)) throw new ToolError(`${k} must be an integer`, "bad_args");
  }
}

function defaultNote(pid, a) {
  return {
    resourceType: "DocumentReference", status: "current", docStatus: "final",
    type: { coding: [{ system: "http://loinc.org", code: "11506-3", display: "Progress note" }] },
    category: [{ coding: [{ system: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category", code: "clinical-note" }] }],
    subject: { reference: `Patient/${pid}` }, date: new Date().toISOString(), description: a.title,
    content: [{ attachment: { contentType: "text/plain", data: btoa(String.fromCharCode(...new TextEncoder().encode(a.text))), title: a.title } }],
    ...(a.encounter_id ? { context: { encounter: [{ reference: `Encounter/${a.encounter_id}` }] } } : {}),
  };
}
