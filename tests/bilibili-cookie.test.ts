import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type CookieHelpers = {
  REQUIRED_BILIBILI_COOKIES: string[];
  MAX_COOKIE_BYTES: number;
  parseCookieInput: (text: string) => Map<string, string>;
  missingRequiredCookies: (pairs: Map<string, string>) => string[];
  mergeAnonymousCookies: (pairs: Map<string, string>, headers: string[]) => Map<string, string>;
  buildCookieHeader: (pairs: Map<string, string>) => string;
};

let helpers: CookieHelpers;

beforeAll(async () => {
  const modulePath = pathToFileURL(path.join(process.cwd(), "scripts", "bilibili-cookie.mjs")).href;
  helpers = await import(/* @vite-ignore */ modulePath) as CookieHelpers;
});

describe("bilibili cookie helpers", () => {
  it("parses the multi-line format copied from browser DevTools", () => {
    const pairs = helpers.parseCookieInput([
      "SESSDATA=abc%2Cdef",
      "bili_jct=c357",
      "  DedeUserID=437085454  ",
      "",
      "invalid line",
    ].join("\n"));

    expect([...pairs.entries()]).toEqual([
      ["SESSDATA", "abc%2Cdef"],
      ["bili_jct", "c357"],
      ["DedeUserID", "437085454"],
    ]);
    expect(helpers.missingRequiredCookies(pairs)).toEqual([]);
  });

  it("keeps the value after the first equals sign and the last duplicate wins", () => {
    const pairs = helpers.parseCookieInput("key=a=b\nSESSDATA=old\nSESSDATA=new");

    expect(pairs.get("key")).toBe("a=b");
    expect(pairs.get("SESSDATA")).toBe("new");
  });

  it("reports missing login cookies", () => {
    const pairs = helpers.parseCookieInput("SESSDATA=only");

    expect(helpers.missingRequiredCookies(pairs)).toEqual(["bili_jct", "DedeUserID"]);
  });

  it("adds anonymous buvid cookies without overwriting explicit ones", () => {
    const pairs = helpers.parseCookieInput("SESSDATA=abc\nbuvid3=manual");
    const merged = helpers.mergeAnonymousCookies(pairs, [
      "buvid3=from-header; Path=/",
      "buvid4=four; Domain=.bilibili.com",
      "other=ignored; Path=/",
    ]);

    expect(merged.get("buvid3")).toBe("from-header");
    expect(merged.get("buvid4")).toBe("four");
    expect(merged.has("other")).toBe(false);
  });

  it("builds one Cookie header line and rejects newlines or oversized values", () => {
    const header = helpers.buildCookieHeader(new Map([
      ["SESSDATA", "abc"],
      ["bili_jct", "def"],
      ["DedeUserID", "123"],
    ]));

    expect(header).toBe("SESSDATA=abc; bili_jct=def; DedeUserID=123");
    expect(() => helpers.buildCookieHeader(new Map([["SESSDATA", "a\nb"]]))).toThrow("不能包含换行");
    expect(() => helpers.buildCookieHeader(new Map([["SESSDATA", "x".repeat(helpers.MAX_COOKIE_BYTES + 1)]])))
      .toThrow("64 KB");
  });
});
