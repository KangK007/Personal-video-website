import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let GET: typeof import("@/app/api/health/route").GET;

beforeAll(async () => {
  ({ GET } = await import("@/app/api/health/route"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type SidecarPayload = { services: { bilibili: { configured: boolean; healthy: boolean; message?: string } } };

async function health(): Promise<SidecarPayload> {
  const response = await GET();
  return await response.json() as SidecarPayload;
}

describe("health route sidecar probe", () => {
  it("reports a slow but healthy sidecar as healthy", async () => {
    vi.useFakeTimers();
    vi.stubEnv("FEED_SIDECAR_URL", "http://127.0.0.1:8001");
    vi.stubEnv("FEED_SIDECAR_TOKEN", "matching-token");
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      // Each request takes 1s: under the 1.5s per-request budget, but more than it
      // in total. A single shared deadline would abort requests 2 and 3.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (call === 1) return new Response("{}", { status: 200 });
      if (call === 2) return new Response(null, { status: 401 });
      return new Response(null, { status: 404 });
    }));

    const pending = health();
    await vi.advanceTimersByTimeAsync(4_000);
    const body = await pending;

    expect(body.services.bilibili).toEqual({ configured: true, healthy: true });
  });

  it("reports a mismatched sidecar token", async () => {
    vi.stubEnv("FEED_SIDECAR_URL", "http://127.0.0.1:8001");
    vi.stubEnv("FEED_SIDECAR_TOKEN", "stale-token");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/openapi.json") return new Response("{}", { status: 200 });
      // The probe path answers 401 for every caller until the token is accepted.
      return new Response(null, { status: 401 });
    }));

    await expect(health()).resolves.toMatchObject({
      services: { bilibili: { configured: true, healthy: false, message: expect.stringContaining("令牌不匹配") } },
    });
  });

  it("reports a missing token without probing forever", async () => {
    vi.stubEnv("FEED_SIDECAR_URL", "http://127.0.0.1:8001");
    vi.stubEnv("FEED_SIDECAR_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(health()).resolves.toMatchObject({
      services: { bilibili: { configured: true, healthy: false, message: "本机抓取服务令牌未配置" } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
