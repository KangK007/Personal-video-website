/**
 * Pure helpers for turning manually copied browser cookies into the single-line
 * Cookie header the Bilibili sidecar expects. Shared by
 * scripts/set-bilibili-cookie.mjs and the unit tests.
 */

export const REQUIRED_BILIBILI_COOKIES = ["SESSDATA", "bili_jct", "DedeUserID"];
export const MAX_COOKIE_BYTES = 64 * 1024;

/** Parses "NAME=value" lines (DevTools copy-paste friendly) into a Map. */
export function parseCookieInput(text) {
  const pairs = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!match || !match[2].trim()) continue;
    pairs.set(match[1], match[2].trim());
  }
  return pairs;
}

export function missingRequiredCookies(pairs) {
  return REQUIRED_BILIBILI_COOKIES.filter((name) => !pairs.has(name));
}

/** Adds anonymous anti-bot cookies (buvid3/buvid4/b_nut) when they are available. */
export function mergeAnonymousCookies(pairs, setCookieHeaders) {
  const merged = new Map(pairs);
  for (const header of setCookieHeaders ?? []) {
    const [pair] = String(header).split(";");
    const match = pair.match(/^\s*([A-Za-z0-9_]+)=(.*)$/);
    if (match && ["buvid3", "buvid4", "b_nut"].includes(match[1]) && match[2].trim()) {
      merged.set(match[1], match[2].trim());
    }
  }
  return merged;
}

/** Serializes the Cookie header and enforces the sidecar's file constraints. */
export function buildCookieHeader(pairs) {
  const header = [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  if (/[\r\n]/.test(header)) throw new Error("Cookie 内容不能包含换行");
  if (Buffer.byteLength(header, "utf8") > MAX_COOKIE_BYTES) throw new Error("Cookie 超过 64 KB 上限");
  return header;
}
