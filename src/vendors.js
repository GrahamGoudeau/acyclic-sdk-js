// Vendor profiles: how five FHIR R4 servers that implement the same standard
// differ on the wire. Sources for each rule: spec/vendors.md.
//
// A profile has:
//   name, auth ("private_key_jwt" | "client_secret_basic")
//   scopes({ write }) -> string[]
//   searchParams(type, params, ehr) -> params      fix up a search before it is sent
//   prepareNote(pid, args, ehr, ctx) -> resource   DocumentReference for create_note
//   tools: { [name]: async (args, h) => result }    replace a tool (athena appointments)
//   supports(tool) -> boolean

const drop = (p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));

const READS = ["Patient", "Condition", "MedicationRequest", "AllergyIntolerance", "Observation", "Encounter", "Appointment", "DocumentReference", "Binary", "Coverage"];
const v1 = (types, write) => [...types.map((t) => `system/${t}.read`), ...(write ? ["system/DocumentReference.write"] : [])];
const v2 = (types, write) => [...types.map((t) => `system/${t}.rs`), ...(write ? ["system/DocumentReference.c"] : [])];

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

function note(pid, a, { contentType = "text/plain", extra = {} } = {}) {
  return {
    resourceType: "DocumentReference", status: "current", docStatus: "final",
    type: { coding: [{ system: "http://loinc.org", code: "11506-3", display: "Progress note" }] },
    category: [{ coding: [{ system: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category", code: "clinical-note" }] }],
    subject: { reference: `Patient/${pid}` }, date: new Date().toISOString(), description: a.title,
    content: [{ attachment: { contentType, data: b64(a.text), title: a.title } }],
    ...extra,
  };
}

// The most recent encounter, for vendors that file notes against one.
async function latestEncounter(pid, ehr, ctx) {
  const { resources } = await ehr.fhir.search("Encounter", ehr.vendor.searchParams("Encounter", { patient: pid }, ehr), { limit: 50, parent: ctx?.span });
  return resources.map((e) => ({ id: e.id, start: e.period?.start ?? "" })).sort((x, y) => (x.start < y.start ? 1 : x.start > y.start ? -1 : 0))[0]?.id;
}

// Observation: Epic rejects category with code; Oracle ignores code when a
// category is present. Send only the code when there is one.
function codeWins(type, p) {
  if (type === "Observation" && p.code) delete p.category;
}

export const epic = {
  name: "epic",
  auth: "private_key_jwt",
  scopes: ({ write } = {}) => v1(READS, write),
  searchParams(type, p) {
    codeWins(type, p);
    if (type === "Condition") p.category ??= "problem-list-item";
    if (type === "DocumentReference" && !p.type) p.category ??= "clinical-note";
    if (type === "Appointment") p["service-category"] ??= "appointment";
    delete p._sort; // unsupported; Epic would ignore it with a warning
    return drop(p);
  },
  async prepareNote(pid, a, ehr, ctx) {
    // Epic files notes against an encounter of the patient, from text/plain.
    const enc = a.encounter_id ?? (await latestEncounter(pid, ehr, ctx));
    if (!enc) throw new Error("Epic notes need an encounter and this patient has none");
    return note(pid, a, { extra: { context: { encounter: [{ reference: `Encounter/${enc}` }] } } });
  },
};

export const oracle = {
  name: "oracle",
  auth: "client_secret_basic",
  // Oracle does not support wildcard scopes; list each resource.
  scopes: ({ write } = {}) => v1(READS, write),
  searchParams(type, p) {
    codeWins(type, p);
    if (type === "Appointment") {
      // Oracle needs date with a prefix and a time on patient searches.
      const dates = (Array.isArray(p.date) ? p.date : [p.date]).filter(Boolean);
      p.date = dates.map((d) => (d.includes("T") ? d : d.startsWith("le") ? `${d}T23:59:59Z` : `${d}T00:00:00Z`));
      if (!p.date.length) p.date = [`ge${new Date().toISOString().slice(0, 10)}T00:00:00Z`];
    }
    delete p._sort;
    return drop(p);
  },
  prepareNote(pid, a) {
    const now = new Date().toISOString();
    const context = { period: { end: now }, ...(a.encounter_id ? { encounter: [{ reference: `Encounter/${a.encounter_id}` }] } : {}) };
    return note(pid, a, { contentType: "text/plain;charset=utf-8", extra: { context } });
  },
};

// athenaOne appointments come from the proprietary API:
// GET /v1/{practiceid}/patients/{patientid}/appointments
const ATHENA_STATUS = { f: "booked", x: "cancelled", o: "proposed", 2: "arrived", 3: "fulfilled", 4: "fulfilled" };

async function athenaAppointments(a, h) {
  const { ehr, patientId, span } = h;
  const practice = ehr.practiceId;
  if (!practice) throw new Error("athena needs practiceId for the appointments API");
  const enterprise = patientId.split(".E-")[1];
  if (!enterprise) { const e = new Error("not an athena patient id (a-{practice}.E-{id})"); e.code = "bad_patient_id"; throw e; }
  const base = ehr.fhir.baseUrl.replace(/\/fhir\/r4$/i, `/v1/${practice}`);
  const body = await ehr.fhir.request("GET", `${base}/patients/${encodeURIComponent(enterprise)}/appointments`, {
    params: { showpast: a.since && a.since < new Date().toISOString().slice(0, 10) ? "true" : undefined }, accept: "application/json", parent: span, resourceType: "Appointment",
  });
  const since = a.since ?? new Date().toISOString().slice(0, 10);
  const items = (body.appointments || []).map((x) => {
    const [mm, dd, yyyy] = String(x.date).split("/");
    const start = `${yyyy}-${mm}-${dd}T${x.starttime}`;
    const t = Date.parse(`${start}:00Z`);
    const end = x.duration && Number.isFinite(t) ? new Date(t + x.duration * 60000).toISOString().slice(0, 16) : undefined;
    return Object.fromEntries(Object.entries({ id: String(x.appointmentid), status: ATHENA_STATUS[x.appointmentstatus] ?? x.appointmentstatus, start, end, type: x.appointmenttype || x.patientappointmenttypename }).filter(([, v]) => v));
  }).filter((x) => x.start.slice(0, 10) >= since && (!a.until || x.start.slice(0, 10) <= a.until));
  items.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));
  return { items, total: items.length, truncated: false };
}

export const athena = {
  name: "athena",
  auth: "client_secret_basic",
  // No wildcards; no system Appointment scope; MDP scope for the proprietary API.
  scopes: () => [...v1(READS.filter((t) => t !== "Appointment"), false), "athena/service/Athenanet.MDP.*"],
  searchParams(type, p, ehr) {
    if (ehr?.practiceId) p["ah-practice"] ??= `Organization/a-1.Practice-${ehr.practiceId}`;
    if (type === "MedicationRequest") p.intent ??= "order";
    delete p._sort;
    return drop(p);
  },
  tools: { list_appointments: athenaAppointments },
  supports: (tool) => tool !== "create_note",
};

export const meditech = {
  name: "meditech",
  auth: "client_secret_basic",
  scopes: ({ write } = {}) => v2(READS, write), // SMART v2 system scopes only
  searchParams(type, p) {
    // MEDITECH's MedicationRequest statuses are active, cancelled, completed.
    if (type === "MedicationRequest" && p.status === "stopped") p.status = "completed";
    delete p._sort;
    return drop(p);
  },
  supports: (tool) => tool !== "create_note",
};

export const ecw = {
  name: "ecw",
  auth: "private_key_jwt",
  scopes: ({ write } = {}) => v1(READS.filter((t) => t !== "Appointment"), write),
  searchParams(type, p) {
    if (type === "MedicationRequest") p.intent ??= "order";
    delete p._sort;
    return drop(p);
  },
  // eCW offers no Appointment API; notes go through contract-only transaction bundles.
  supports: (tool) => tool !== "list_appointments" && tool !== "create_note",
};

// Any other US Core server: standard params, private_key_jwt, v2 scopes.
export const generic = {
  name: "generic",
  auth: "private_key_jwt",
  scopes: ({ write } = {}) => v2(READS, write),
  searchParams: (type, p) => drop(p),
};

export const VENDORS = { epic, oracle, athena, meditech, ecw, generic };
