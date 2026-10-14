import { afterEach, describe, expect, it, vi } from "vitest";

import { requestSyncBatch, SYNC_REQUEST_TIMEOUT_MS, SYNC_RETRY_DELAY_MS } from "@/lib/feed-sync";
import type { Creator } from "@/lib/feed-types";

const creator: Creator = {
  id: "creator-1",
  platform: "bilibili",
  profileUrl: "https://space.bilibili.com/123456",
  name: "测试博主",
  enabled: true,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("requestSyncBatch retry policy", () => {
  it("does not repeat a batch once the whole request budget has elapsed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const pending = requestSyncBatch([creator], controller.signal, []);
    const assertion = expect(pending).rejects.toThrow("同步服务响应超时");
    await vi.advanceTimersByTimeAsync(SYNC_REQUEST_TIMEOUT_MS + 10);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries a transient server failure once", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: "同步服务暂时不可用" }),
      { status: 503, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const pending = requestSyncBatch([creator], new AbortController().signal, []);
    const assertion = expect(pending).rejects.toThrow(/HTTP 503|暂时不可用/);
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_DELAY_MS + 10);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
