import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let getSidecarBaseUrl: typeof import("@/lib/server/bilibili-sync").getSidecarBaseUrl;
let probeSidecar: typeof import("@/lib/server/bilibili-sync").probeSidecar;
let syncBilibiliCreator: typeof import("@/lib/server/bilibili-sync").syncBilibiliCreator;

beforeAll(async () => {
  ({ getSidecarBaseUrl, probeSidecar, syncBilibiliCreator } = await import("@/lib/server/bilibili-sync"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const creator = {
  id: "creator-bilibili",
  platform: "bilibili" as const,
  profileUrl: "https://space.bilibili.com/123456",
  name: "测试博主",
};

/** Mirrors the sidecar middleware: only /openapi.json skips the bearer check. */
function sidecarFetch(expectedToken: string) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/openapi.json") {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization !== `Bearer ${expectedToken}`) {
      return new Response(JSON.stringify({ detail: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ detail: "Not Found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("getSidecarBaseUrl", () => {
  it("keeps only the origin so probe and API calls resolve the same paths", () => {
    vi.stubEnv("FEED_SIDECAR_URL", "http://127.0.0.1:8001/api/");
    expect(getSidecarBaseUrl()).toBe("http://127.0.0.1:8001");
  });

  it("rejects non-loopback hosts", () => {
    vi.stubEnv("FEED_SIDECAR_URL", "http://192.168.1.10:8001");
    expect(getSidecarBaseUrl()).toBeNull();
  });
});

describe("probeSidecar", () => {
  it("fails with an actionable message when no token is configured", async () => {
    vi.stubEnv("FEED_SIDECAR_TOKEN", "");
    vi.stubGlobal("fetch", sidecarFetch("expected"));

    await expect(probeSidecar("http://127.0.0.1:8001")).rejects.toThrow("未配置本机抓取服务令牌");
  });

  it("fails when the sidecar does not enforce authentication", async () => {
    vi.stubEnv("FEED_SIDECAR_TOKEN", "token-value");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));

    await expect(probeSidecar("http://127.0.0.1:8001")).rejects.toThrow("未启用鉴权");
  });

  it("reports a mismatched token instead of letting every creator fail with Unauthorized", async () => {
    vi.stubEnv("FEED_SIDECAR_TOKEN", "stale-token");
    vi.stubGlobal("fetch", sidecarFetch("rotated-token"));

    await expect(probeSidecar("http://127.0.0.1:8001")).rejects.toThrow("令牌不匹配");
  });

  it("accepts a sidecar whose token matches", async () => {
    vi.stubEnv("FEED_SIDECAR_TOKEN", "matching-token");
    vi.stubGlobal("fetch", sidecarFetch("matching-token"));

    await expect(probeSidecar("http://127.0.0.1:8001")).resolves.toBeUndefined();
  });

  it("maps a rejected bearer token during pagination to the same actionable message", async () => {
    vi.stubEnv("FEED_SIDECAR_TOKEN", "wrong-token");
    vi.stubGlobal("fetch", sidecarFetch("right-token"));

    await expect(syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      "2026-09-13T12:00:00.000Z",
    )).rejects.toThrow("令牌不匹配");
  });
});
