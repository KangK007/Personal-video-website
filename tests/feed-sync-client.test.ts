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

  it("retries a batch when every result is a retryable provider failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        configured: false,
        results: [{
          creatorId: "creator-1",
          status: "error",
          count: 0,
          complete: false,
          mode: "snapshot",
          failureCode: "provider_unavailable",
          message: "哔站本机抓取服务未启动或无法连接",
        }],
      }), { status: 502, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        configured: true,
        videos: [],
        results: [{ creatorId: "creator-1", status: "success", count: 0, complete: true, mode: "snapshot" }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = requestSyncBatch([creator], new AbortController().signal, []);
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_DELAY_MS + 10);

    await expect(pending).resolves.toMatchObject({
      results: [{ creatorId: "creator-1", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves per-creator provider details when the recovery attempt also fails", async () => {
    vi.useFakeTimers();
    const failure = {
      creatorId: "creator-1",
      status: "error",
      count: 0,
      complete: false,
      mode: "snapshot",
      failureCode: "provider_unavailable",
      message: "抓取服务返回 502: upstream unavailable",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      configured: true,
      videos: [],
      results: [failure],
    }), { status: 502, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = requestSyncBatch([creator], new AbortController().signal, []);
    const assertion = expect(pending).resolves.toMatchObject({ results: [failure] });
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_DELAY_MS + 10);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry platform rate-limit results", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      configured: true,
      results: [{
        creatorId: "creator-1",
        status: "error",
        count: 0,
        complete: false,
        mode: "snapshot",
        failureCode: "douyin_rate_limited",
        message: "抖音拒绝了投稿请求，疑似触发限流或登录状态异常",
      }],
    }), { status: 502, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestSyncBatch([creator], new AbortController().signal, []))
      .resolves.toMatchObject({ results: [{ failureCode: "douyin_rate_limited" }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries only transient provider failures from a mixed failure batch", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        configured: true,
        results: [
          { creatorId: "creator-1", status: "error", failureCode: "provider_unavailable" },
          { creatorId: "creator-2", status: "error", failureCode: "douyin_rate_limited" },
        ],
      }), { status: 502, headers: { "content-type": "application/json" } }))
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { creators: Array<{ id: string }> };
        expect(body.creators.map((item) => item.id)).toEqual(["creator-1"]);
        return new Response(JSON.stringify({
          configured: true,
          results: [{ creatorId: "creator-1", status: "success", count: 0, complete: true, mode: "snapshot" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      });
    vi.stubGlobal("fetch", fetchMock);

    const pending = requestSyncBatch([creator, { ...creator, id: "creator-2" }], new AbortController().signal, []);
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_DELAY_MS + 10);

    await expect(pending).resolves.toMatchObject({
      results: [{ status: "success" }, { failureCode: "douyin_rate_limited" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries only transiently failed creators from a partially successful batch", async () => {
    vi.useFakeTimers();
    const secondCreator = { ...creator, id: "creator-2", name: "第二位博主" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        configured: true,
        videos: [],
        results: [
          { creatorId: "creator-1", status: "success", count: 0, complete: true, mode: "snapshot" },
          { creatorId: "creator-2", status: "error", count: 0, complete: false, mode: "snapshot", failureCode: "provider_unavailable" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { creators: Array<{ id: string }> };
        expect(body.creators.map((item) => item.id)).toEqual(["creator-2"]);
        return new Response(JSON.stringify({
          configured: true,
          videos: [],
          results: [{ creatorId: "creator-2", status: "success", count: 0, complete: true, mode: "snapshot" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      });
    vi.stubGlobal("fetch", fetchMock);

    const pending = requestSyncBatch([creator, secondCreator], new AbortController().signal, []);
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_DELAY_MS + 10);

    await expect(pending).resolves.toMatchObject({
      results: [
        { creatorId: "creator-1", status: "success" },
        { creatorId: "creator-2", status: "success" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
