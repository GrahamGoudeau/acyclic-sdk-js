# Working in acyclic-sdk-js

- Zero runtime dependencies. Node 20+ and browsers. Use `fetch` and WebCrypto only. Do not add packages, including dev dependencies.
- `spec/` is a copy of acyclic-sdk-spec. Change it there, then `npm run sync-spec` (regenerates `src/spec.js`). Never edit `src/spec.js` by hand.
- Projections must match `spec/fixtures/projections` exactly. Add a fixture when you change a projection rule.
- Telemetry: every attribute goes through the allow-list in `src/telemetry.js`. Never put query strings, bodies, resource ids, prompts or tool arguments into spans, logs or error messages.
- Vendor differences live in `src/vendors.js` with a source in `spec/vendors.md`. Do not special-case vendors anywhere else.
- Tests: `npm test`. End-to-end against a sandbox: `SANDBOX_URL=https://sandbox.acyclic.sh npm test` (or a local `acyclic-sandbox` on its port).
