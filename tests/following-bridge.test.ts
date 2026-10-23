import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";

vi.mock("server-only", () => ({}));

import { makeBilibiliBridgeScript } from "@/lib/following-list";
import {
  createFollowingBridgeSession,
  normalizeFollowingBridgePayload,
  setFollowingBridgePayload,
  consumeFollowingBridgePayload,
} from "@/lib/server/following-bridge";

describe("following browser bridge", () => {
  it("normalizes and de-duplicates browser records without accepting invalid ids", () => {
    const payload = normalizeFollowingBridgePayload({
      account: { id: "123", name: "当前账号" },
      total: 2,
      invalidCount: 1,
      creators: [
        { platformUserId: 456, name: "作者 A", avatarUrl: "//i0.hdslb.com/avatar.jpg" },
        { platformUserId: "456", name: "重复作者" },
        { platformUserId: "bad id", name: "无效" },
      ],
    });
    expect(payload.creators).toHaveLength(1);
    expect(payload.creators[0]).toMatchObject({
      platform: "bilibili",
      platformUserId: "456",
      profileUrl: "https://space.bilibili.com/456",
      avatarUrl: "https://i0.hdslb.com/avatar.jpg",
    });
    expect(payload.result).toMatchObject({ status: "partial", received: 1, total: 2, invalidCount: 2 });
  });

  it("allows a bridge token to be consumed only once", () => {
    const session = createFollowingBridgeSession();
    const payload = normalizeFollowingBridgePayload({ account: { id: "1", name: "账号" }, total: 0, creators: [] });
    expect(setFollowingBridgePayload(session.token, payload)).toBe(true);
    expect(consumeFollowingBridgePayload(session.token)).toEqual(payload);
    expect(consumeFollowingBridgePayload(session.token)).toBeNull();
  });

  it("keeps a session valid long enough for a large list to finish collecting", () => {
    const session = createFollowingBridgeSession();
    const ttl = session.expiresAt - Date.now();
    // Collecting hundreds of pages can take many minutes before the handoff starts.
    expect(ttl).toBeGreaterThan(20 * 60 * 1_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60 * 1_000 + 1_000);
  });

  it("keeps a paginated failure marked partial even when counts happen to match", () => {
    const payload = normalizeFollowingBridgePayload({
      account: { id: "123", name: "当前账号" },
      total: 1,
      creators: [{ platformUserId: "456", name: "作者" }],
      message: "分页请求失败",
    });
    expect(payload.result).toMatchObject({ status: "partial", received: 1, total: 1, message: "分页请求失败" });
  });

  it("generates a script that never asks for or prints cookies", () => {
    const script = makeBilibiliBridgeScript("http://127.0.0.1:3000", "token-value");
    expect(script).toContain("https://api.bilibili.com/x/relation/followings");
    expect(script).toContain("/following/bridge");
    expect(script).not.toMatch(/document\.cookie|Cookie:/i);
  });

  it("runs the generated script through an authenticated page and posts the list", async () => {
    const script = makeBilibiliBridgeScript("http://127.0.0.1:3000", "token-value");
    let posted: unknown;
    const listeners = new Set<(event: unknown) => void>();
    const popup = {
      closed: false,
      close: () => undefined,
      postMessage: (data: { type: string; token: string; payload: unknown }) => {
        posted = data.payload;
        queueMicrotask(() => listeners.forEach((listener) => listener({
          origin: "http://127.0.0.1:3000", source: popup,
          data: { type: "following-list-ack", token: data.token, ok: true },
        })));
      },
    };
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://api.bilibili.com/x/web-interface/nav") return new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: 123, uname: "我的账号" } }));
      if (url.startsWith("https://api.bilibili.com/x/relation/followings?")) return new Response(JSON.stringify({ code: 0, data: { total: 1, list: [{ mid: 456, uname: "作者" }] } }));
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const alerts: string[] = [];
    await (runInNewContext(script, {
      fetch,
      Response,
      URLSearchParams,
      AbortController,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      encodeURIComponent,
      location: { hostname: "www.bilibili.com" },
      window: {
        open: () => popup,
        addEventListener: (_type: string, listener: (event: unknown) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: unknown) => void) => listeners.delete(listener),
      },
      console: { log: () => undefined, error: () => undefined },
      alert: (message: string) => alerts.push(message),
    }) as Promise<void>);
    expect(alerts).toEqual([]);
    expect(fetch).toHaveBeenCalledWith("https://api.bilibili.com/x/web-interface/nav", expect.anything());
    expect(posted).toMatchObject({ account: { id: "123" }, total: 1, creators: [{ platformUserId: "456" }] });
  });
});
