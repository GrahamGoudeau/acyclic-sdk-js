import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as P from "../src/projections.js";
import { base64ToText } from "../src/util.js";

const dir = new URL("../spec/fixtures/projections/", import.meta.url);
for (const file of readdirSync(dir)) {
  const kind = file.replace(".json", "");
  for (const c of JSON.parse(readFileSync(new URL(file, dir), "utf8"))) {
    test(`${kind}: ${c.name}`, () => {
      let got;
      if (kind === "document_text") {
        const a = c.input.content[0].attachment;
        got = P.documentText(c.input, base64ToText(a.data), a.contentType, c.max_chars);
      } else got = P.byName[kind](c.input);
      assert.deepEqual(got, c.expected);
    });
  }
}
