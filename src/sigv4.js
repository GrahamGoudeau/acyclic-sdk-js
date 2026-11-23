// AWS Signature Version 4 with WebCrypto, enough for Bedrock JSON POSTs.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

// Non-S3 services canonicalize the path as sent, encoded once more
// (so a model id's %3A becomes %253A).
const encodeSegment = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export async function sigV4({ method, url, region, service, body = "", credentials, headers = {}, now = new Date() }) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) throw new Error("AWS credentials are required");
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = await sha256(body);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  if (credentials.sessionToken) h["x-amz-security-token"] = credentials.sessionToken;
  const names = Object.keys(h).sort();
  const canonicalUri = u.pathname.split("/").map(encodeSegment).join("/") || "/";
  const query = [...u.searchParams].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [method, canonicalUri, query, names.map((n) => `${n}:${h[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key = await hmac("AWS4" + credentials.secretAccessKey, day);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, toSign));
  const { host, ...send } = h; // fetch sets Host itself and forbids setting it
  return { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}
