// FHIR R4 resource -> small flat object. Rules: spec/projections.md.

const SYSTEMS = {
  "http://snomed.info/sct": "SNOMED",
  "http://loinc.org": "LOINC",
  "http://hl7.org/fhir/sid/icd-10-cm": "ICD-10-CM",
  "http://www.nlm.nih.gov/research/umls/rxnorm": "RXNORM",
  "http://hl7.org/fhir/sid/cvx": "CVX",
};

// Build an object, dropping absent values.
function obj(pairs) {
  const out = {};
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

export function display(cc) {
  if (!cc) return undefined;
  if (cc.text) return cc.text;
  for (const c of cc.coding || []) if (c.display) return c.display;
  for (const c of cc.coding || []) if (c.code) return c.code;
  return undefined;
}

export function codes(cc) {
  return (cc?.coding || []).filter((c) => c.code).map((c) => `${SYSTEMS[c.system] ?? c.system ?? ""}|${c.code}`);
}

const status = (cc) => cc?.coding?.find((c) => c.code)?.code;
const ref = (r) => r?.display || r?.reference;
const hasCode = (cc, code) => (cc?.coding || []).some((c) => c.code === code);

function qtyText(q) {
  if (!q || q.value === undefined) return undefined;
  const unit = q.unit ?? q.code;
  return unit ? `${q.value} ${unit}` : String(q.value);
}

export function patient(r) {
  const names = r.name || [];
  const n = names.find((x) => x.use === "official") || names[0];
  let name;
  if (n) name = n.text || [...(n.given || []), n.family].filter(Boolean).join(" ");
  const mrn = (r.identifier || []).find((i) => hasCode(i.type, "MR"))?.value;
  const deceased = r.deceasedBoolean === true || r.deceasedDateTime !== undefined ? true : undefined;
  return obj([["id", r.id], ["name", name], ["birth_date", r.birthDate], ["gender", r.gender], ["mrn", mrn], ["deceased", deceased]]);
}

export function condition(r) {
  return obj([
    ["id", r.id], ["display", display(r.code)], ["codes", codes(r.code)],
    ["clinical_status", status(r.clinicalStatus)],
    ["onset", r.onsetDateTime ?? r.onsetPeriod?.start], ["recorded", r.recordedDate],
  ]);
}

export function medication(r) {
  return obj([
    ["id", r.id], ["display", display(r.medicationCodeableConcept) ?? r.medicationReference?.display],
    ["codes", codes(r.medicationCodeableConcept)], ["status", r.status],
    ["dosage", r.dosageInstruction?.[0]?.text], ["authored_on", r.authoredOn], ["requester", ref(r.requester)],
  ]);
}

export function allergy(r) {
  const reactions = [];
  for (const rx of r.reaction || []) for (const m of rx.manifestation || []) {
    const d = display(m);
    if (d && !reactions.includes(d)) reactions.push(d);
  }
  return obj([
    ["id", r.id], ["display", display(r.code)], ["clinical_status", status(r.clinicalStatus)],
    ["criticality", r.criticality], ["reactions", reactions], ["recorded", r.recordedDate],
  ]);
}

export function observation(r) {
  let value;
  if (r.valueQuantity) value = qtyText(r.valueQuantity);
  else if (r.valueCodeableConcept) value = display(r.valueCodeableConcept);
  else if (r.valueString !== undefined) value = r.valueString;
  else if (r.component?.length && r.component.every((c) => c.valueQuantity?.value !== undefined)) {
    const q0 = r.component[0].valueQuantity;
    const unit = q0.unit ?? q0.code;
    value = r.component.map((c) => c.valueQuantity.value).join("/") + (unit ? ` ${unit}` : "");
  }
  const q = r.valueQuantity;
  return obj([
    ["id", r.id], ["display", display(r.code)],
    ["loinc", r.code?.coding?.find((c) => c.system === "http://loinc.org")?.code],
    ["value", value], ["value_number", q?.value], ["unit", q ? q.unit ?? q.code : undefined],
    ["interpretation", display(r.interpretation?.[0])],
    ["effective", r.effectiveDateTime ?? r.effectivePeriod?.start ?? r.issued],
    ["category", r.category?.flatMap((c) => c.coding || []).find((c) => c.code)?.code],
  ]);
}

export function encounter(r) {
  return obj([
    ["id", r.id], ["status", r.status], ["class", r.class?.code], ["type", display(r.type?.[0])],
    ["start", r.period?.start], ["end", r.period?.end], ["reason", display(r.reasonCode?.[0])],
    ["location", ref(r.location?.[0]?.location)],
    ["provider", ref((r.participant || []).find((p) => p.individual)?.individual)],
  ]);
}

export function appointment(r) {
  const actor = (prefix) => ref((r.participant || []).find((p) => p.actor?.reference?.startsWith(prefix))?.actor);
  return obj([
    ["id", r.id], ["status", r.status], ["start", r.start], ["end", r.end],
    ["type", display(r.appointmentType) ?? display(r.serviceType?.[0])], ["description", r.description],
    ["practitioner", actor("Practitioner/")], ["location", actor("Location/")],
  ]);
}

function docTitle(r) {
  return r.description || r.content?.[0]?.attachment?.title || display(r.type);
}

export function document(r) {
  return obj([
    ["id", r.id], ["title", docTitle(r)], ["type", display(r.type)], ["date", r.date],
    ["author", ref(r.author?.[0])], ["content_type", r.content?.[0]?.attachment?.contentType], ["status", r.status],
  ]);
}

export function coverage(r) {
  const plan = (r.class || []).find((c) => hasCode(c.type, "plan"));
  return obj([
    ["id", r.id], ["status", r.status], ["payer", ref(r.payor?.[0])], ["plan", plan?.value ?? plan?.name],
    ["member_id", r.subscriberId ?? r.identifier?.[0]?.value], ["relationship", display(r.relationship)],
    ["period_start", r.period?.start], ["period_end", r.period?.end],
  ]);
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

export function htmlToText(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]).replace(/\s+/g, " ").trim();
}

// text: the decoded attachment body. contentType decides HTML handling.
export function documentText(r, text, contentType, maxChars = 4000) {
  let t = /html/i.test(contentType || "") ? htmlToText(text) : text.trim();
  const chars = Array.from(t);
  const truncated = chars.length > maxChars;
  if (truncated) t = chars.slice(0, maxChars).join("");
  return { ...obj([["id", r.id], ["title", docTitle(r)], ["text", t]]), truncated };
}

export const byName = { patient, condition, medication, allergy, observation, encounter, appointment, document, coverage };
