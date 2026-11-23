// Small helpers that work the same in Node 20+ and browsers.

export function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const base64ToText = (b64) => new TextDecoder().decode(base64ToBytes(b64));

export function bytesToBase64Url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const textToBase64Url = (s) => bytesToBase64Url(new TextEncoder().encode(s));

export function randomId(prefix = "") {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
