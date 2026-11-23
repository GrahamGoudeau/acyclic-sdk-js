// End-to-end against a running acyclic-sandbox: SANDBOX_URL=http://localhost:8190 node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, createSession, generateKeyPair, VENDORS } from "../src/index.js";

const base = process.env.SANDBOX_URL;
const VENDOR_IDS = ["epic", "oracle", "athena", "meditech", "ecw"];

async function register(vendor) {
  const v = VENDORS[vendor];
  const body = { vendor, name: "sdk e2e" };
  let key;
  if (v.auth === "private_key_jwt") { key = await generateKeyPair("RS384"); body.jwks = { keys: [key.publicJwk] }; }
  const res = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, 201, await res.clone().text());
  return { reg: await res.json(), key };
}

for (const vendor of VENDOR_IDS) {
  test(`${vendor}: every read tool against the mock`, { skip: !base }, async () => {
    const { reg, key } = await register(vendor);
    const lines = [];
    const ehr = await connect({
      vendor, baseUrl: reg.fhir_base_url, clientId: reg.client_id, clientSecret: reg.client_secret,
      privateKey: key?.privateKey, kid: key?.kid, practiceId: reg.practice_id, write: true,
      telemetry: { startSpan: (n, a) => ({ setAttributes() {}, end() { lines.push(JSON.stringify({ n, a })); } }), log: (l, n, a) => lines.push(JSON.stringify({ l, n, a })), audit: (r) => lines.push(JSON.stringify(r)) },
    });
    const s = createSession(ehr, { allowWrites: true, approve: async () => true });
    const found = await s.call("find_patient", { family: "Okafor", given: "Samuel", birthdate: "1948-11-19" });
    assert.ok(found.ok, found.error);
    assert.equal(found.result.items.length, 1);
    const pid = found.result.items[0].id;
    assert.ok((await s.call("select_patient", { patient_id: pid })).ok);
    for (const [name, args] of [["get_patient", {}], ["list_conditions", {}], ["list_medications", { status: "all" }], ["list_allergies", {}],
      ["get_labs_vitals", { category: "laboratory", limit: 40 }], ["get_labs_vitals", { category: "vital-signs", code: "8867-4" }],
      ["list_encounters", { limit: 5 }], ["list_appointments", {}], ["list_documents", {}], ["get_coverage", {}]]) {
      if (!s.definitions().some((d) => d.name === name)) continue; // vendor does not offer it
      const r = await s.call(name, args);
      assert.ok(r.ok, `${name}: ${r.error}`);
      if (r.result.items && name !== "list_allergies") assert.ok(r.result.items.length > 0, `${name} returned nothing`);
    }
    const labs = await s.call("get_labs_vitals", { limit: 40 });
    assert.equal(labs.result.items.length, 40, "paging past the first page");
    const docs = await s.call("list_documents", {});
    const text = await s.call("read_document", { document_id: docs.result.items[0].id });
    assert.ok(text.ok, text.error);
    assert.match(text.result.text, /SYNTHETIC RECORD/);
    if (s.definitions().some((d) => d.name === "create_note")) {
      const note = await s.call("create_note", { title: "E2E note", text: "Reviewed chart." });
      assert.ok(note.ok, note.error);
      const after = await s.call("list_documents", {});
      assert.ok(after.result.items.some((d) => d.title === "E2E note"));
    }
    const telemetry = lines.join("\n");
    assert.doesNotMatch(telemetry, /Okafor|Samuel|1948-11-19/, "patient data leaked into telemetry");
    assert.ok(!telemetry.includes(pid), "raw patient id leaked into telemetry");
  });
}
