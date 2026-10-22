import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkBilibiliLogin: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/bilibili-browser", () => ({
  checkBilibiliLogin: mocks.checkBilibiliLogin,
}));

type RouteModule = typeof import("@/app/api/bilibili/session/route");
let POST: RouteModule["POST"];
let tempDir = "";

beforeEach(async () => {
  vi.resetModules();
  mocks.checkBilibiliLogin.mockReset();
  tempDir = mkdtempSync(path.join(os.tmpdir(), "bili-session-"));
  vi.stubEnv("BILIBILI_COOKIE_FILE", path.join(tempDir, "cookie.txt"));
  ({ POST } = await import("@/app/api/bilibili/session/route"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function sessionRequest(origin = "http://127.0.0.1:3000") {
  return new Request("http://127.0.0.1:3000/api/bilibili/session", {
    method: "POST",
    headers: { host: "127.0.0.1:3000", origin },
  });
}

function writeCookie(value: string) {
  writeFileSync(path.join(tempDir, "cookie.txt"), value);
}

describe("bilibili session route", () => {
  it("reports a logged-in account", async () => {
    mocks.checkBilibiliLogin.mockResolvedValue({ status: "logged-in", accountName: "测试账号" });

    const response = await POST(sessionRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "logged-in", accountName: "测试账号" });
  });

  it("reports an expired cookie with an actionable message", async () => {
    mocks.checkBilibiliLogin.mockResolvedValue({
      status: "logged-out",
      message: "哔站 Cookie 已失效或未登录，请重新更新 Cookie",
    });

    await expect((await POST(sessionRequest())).json()).resolves.toMatchObject({ status: "logged-out" });
  });

  it("caches the probe so a sync run does not launch a browser per request", async () => {
    mocks.checkBilibiliLogin.mockResolvedValue({ status: "logged-in" });

    await POST(sessionRequest());
    const second = await POST(sessionRequest());

    expect(mocks.checkBilibiliLogin).toHaveBeenCalledTimes(1);
    await expect(second.json()).resolves.toMatchObject({ status: "logged-in" });
  });

  it("degrades to unavailable when the probe itself fails", async () => {
    mocks.checkBilibiliLogin.mockRejectedValue(new Error("未找到 Edge 或 Chrome"));

    await expect((await POST(sessionRequest())).json()).resolves.toMatchObject({ status: "unavailable" });
  });

  it("rejects a non-loopback origin", async () => {
    const response = await POST(sessionRequest("http://evil.example"));

    expect(response.status).toBe(403);
    expect(mocks.checkBilibiliLogin).not.toHaveBeenCalled();
  });

  it("re-probes when the cookie file changes so an updated Cookie is not blocked by the cache", async () => {
    mocks.checkBilibiliLogin
      .mockResolvedValueOnce({ status: "logged-out" })
      .mockResolvedValueOnce({ status: "logged-in" });
    writeCookie("SESSDATA=old");
    await POST(sessionRequest());
    writeCookie("SESSDATA=new-and-longer");

    const second = await POST(sessionRequest());

    expect(mocks.checkBilibiliLogin).toHaveBeenCalledTimes(2);
    await expect(second.json()).resolves.toMatchObject({ status: "logged-in" });
  });

  it("does not cache the answer of a cancelled probe", async () => {
    mocks.checkBilibiliLogin.mockResolvedValue({ status: "logged-in" });
    const controller = new AbortController();
    controller.abort();
    const cancelled = new Request("http://127.0.0.1:3000/api/bilibili/session", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
      signal: controller.signal,
    });

    await expect((await POST(cancelled)).json()).resolves.toMatchObject({ status: "unavailable" });
    await POST(sessionRequest());

    expect(mocks.checkBilibiliLogin).toHaveBeenCalledTimes(2);
  });
});
