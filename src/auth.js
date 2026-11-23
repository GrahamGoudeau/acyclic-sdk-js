// SMART Backend Services (private_key_jwt) and client_secret_basic token
// clients. Bring your own credentials: nothing here is stored or persisted.

import { base64ToBytes, bytesToBase64Url, textToBase64Url, randomId } from "./util.js";

const ALGS = {
  RS384: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, sign: { name: "RSASSA-PKCS1-v1_5" } },
  ES384: { import: { name: "ECDSA", namedCurve: "P-384" }, sign: { name: "ECDSA", hash: "SHA-384" } },
};

// privateKey: a CryptoKey, a PKCS#8 PEM string ("BEGIN PRIVATE KEY"), or a private JWK object.
export async function importPrivateKey(privateKey, alg = "RS384") {
  const a = ALGS[alg];
  if (!a) throw new Error(`unsupported alg ${alg}; use RS384 or ES384`);
  if (typeof CryptoKey !== "undefined" && privateKey instanceof CryptoKey) return privateKey;
  if (typeof privateKey === "object" && privateKey?.kty) return crypto.subtle.importKey("jwk", privateKey, a.import, false, ["sign"]);
  if (typeof privateKey === "string") {
    if (privateKey.includes("BEGIN RSA PRIVATE KEY") || privateKey.includes("BEGIN EC PRIVATE KEY"))
      throw new Error("key is PKCS#1/SEC1; convert with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.p8.pem");
    const body = privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    return crypto.subtle.importKey("pkcs8", base64ToBytes(body), a.import, false, ["sign"]);
  }
  throw new Error("privateKey must be a CryptoKey, PKCS#8 PEM string or JWK");
}

// Signed client assertion (RFC 7523) as SMART Backend Services requires.
export async function clientAssertion({ clientId, tokenUrl, key, alg = "RS384", kid, lifetimeSeconds = 240 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg, typ: "JWT", ...(kid ? { kid } : {}) };
  const claims = { iss: clientId, sub: clientId, aud: tokenUrl, jti: randomId(), iat: now, nbf: now, exp: now + lifetimeSeconds };
  const input = `${textToBase64Url(JSON.stringify(header))}.${textToBase64Url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(ALGS[alg].sign, key, new TextEncoder().encode(input));
  return `${input}.${bytesToBase64Url(sig)}`;
}

export class AuthError extends Error {
  constructor(status, code) {
    super(`token request failed: ${status}${code ? ` ${code}` : ""}`);
    this.status = status;
    this.code = code; // OAuth error code only; descriptions can echo request data and are dropped
  }
}

// Returns getToken({ force }) with in-memory caching and single-flight refresh.
export function tokenSource({ method, clientId, clientSecret, privateKey, alg = "RS384", kid, tokenUrl, scopes, fetch: f = fetch, onRequest, telemetry, vendor }) {
  let cached; // { token, expiresAt }
  let inflight;
  let keyPromise;

  async function request() {
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (scopes?.length) form.set("scope", scopes.join(" "));
    const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (method === "client_secret_basic") {
      if (!clientSecret) throw new Error("clientSecret is required for client_secret_basic");
      headers.authorization = "Basic " + btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`);
    } else {
      if (!privateKey) throw new Error("privateKey is required for private_key_jwt");
      keyPromise ??= importPrivateKey(privateKey, alg);
      form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      form.set("client_assertion", await clientAssertion({ clientId, tokenUrl, key: await keyPromise, alg, kid }));
    }
    const res = await f(tokenUrl, { method: "POST", headers, body: form.toString() });
    onRequest?.(res);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new AuthError(res.status, body.error);
    const ttl = Number(body.expires_in) || 300;
    cached = { token: body.access_token, expiresAt: Date.now() + ttl * 1000, scope: body.scope };
    return cached.token;
  }

  // One "POST token" span and a token.refresh log per request; never the
  // assertion, secret or token.
  async function traced() {
    const host = (() => { try { return new URL(tokenUrl).hostname; } catch { return undefined; } })();
    const span = telemetry?.startSpan("POST token", { "http.request.method": "POST", "server.address": host, "acyclic.vendor": vendor });
    try {
      const tok = await request();
      span?.setAttributes({ "http.response.status_code": 200 });
      span?.end();
      telemetry?.log("info", "token.refresh", { "acyclic.vendor": vendor, "server.address": host });
      return tok;
    } catch (e) {
      span?.setAttributes({ "http.response.status_code": e.status, "error.type": e.code ?? e.type ?? "auth" });
      span?.end(e);
      throw e;
    }
  }

  return async function getToken({ force = false } = {}) {
    if (!force && cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    inflight ??= traced().finally(() => { inflight = undefined; });
    return inflight;
  };
}

// Public JWK for a private key you generated in code (handy for the sandbox
// and for writing a JWKS file to register with a vendor).
export async function generateKeyPair(alg = "RS384") {
  const params = alg === "RS384"
    ? { ...ALGS.RS384.import, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
    : ALGS.ES384.import;
  const pair = await crypto.subtle.generateKey(params, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = randomId().slice(0, 16);
  return { privateKey: pair.privateKey, publicJwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, crv: jwk.crv, x: jwk.x, y: jwk.y, alg, use: "sig", kid }, kid };
}
