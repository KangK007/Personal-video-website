import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let syncBilibiliCreator: typeof import("@/lib/server/bilibili-sync").syncBilibiliCreator;

beforeAll(async () => {
  ({ syncBilibiliCreator } = await import("@/lib/server/bilibili-sync"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const creator = {
  id: "creator-bilibili",
  platform: "bilibili" as const,
  profileUrl: "https://space.bilibili.com/123456",
  name: "测试博主",
};

const syncedAt = "2026-09-13T12:00:00.000Z";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function videoPage(items: unknown[], page: Record<string, unknown>) {
  return {
    code: 0,
    data: {
      list: { vlist: items },
      page,
    },
  };
}

describe("syncBilibiliCreator", () => {
  it("normalizes a complete page and sends the configured Bearer token", async () => {
    vi.stubEnv("FEED_SIDECAR_TOKEN", "local-test-token");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(videoPage([{
        bvid: "BV1abcDEF12",
        title: "测试视频",
        created: 1_725_000_000,
        duration: 125,
      }], { pn: 1, ps: 30, count: 1 })))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { name: "平台昵称", face: "https://i.example/avatar.jpg" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
    );

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]).toMatchObject({
      creatorId: creator.id,
      platform: "bilibili",
      videoUrl: "https://www.bilibili.com/video/BV1abcDEF12",
      title: "测试视频",
      duration: "02:05",
      source: "feed-sync",
      createdAt: syncedAt,
    });
    expect(result.profile).toEqual({
      name: "平台昵称",
      avatarUrl: "https://i.example/avatar.jpg",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: {
        Accept: "application/json",
        Authorization: "Bearer local-test-token",
      },
      cache: "no-store",
      redirect: "error",
    });
  });

  it.each(["BV123456", `BV${"a".repeat(32)}`])("accepts a supported BVID boundary %s", async (bvid) => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse(videoPage([{ bvid, title: "边界作品" }], { pn: 1, ps: 30, count: 1 })))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: {} })));

    const result = await syncBilibiliCreator("http://127.0.0.1:8001", creator, syncedAt);

    expect(result.videos[0].videoUrl).toBe(`https://www.bilibili.com/video/${bvid}`);
  });

  it("rejects the whole snapshot when an entry has no valid BVID", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(videoPage([{
      id: "not-a-bvid",
      title: "无效投稿",
    }], { pn: 1, ps: 30, count: 1 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
    )).rejects.toThrow("缺少有效 BVID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects repeated pages when the reported total is not reached", async () => {
    const repeatedItem = { bvid: "BV1abcDEF12", title: "重复投稿" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(videoPage([repeatedItem], { pn: 1, ps: 1, count: 2 })))
      .mockResolvedValueOnce(jsonResponse(videoPage([repeatedItem], { pn: 2, ps: 1, count: 2 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
    )).rejects.toThrow("分页重复");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops safely when the sidecar omits pagination metadata", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(videoPage([
        { bvid: "BV1abcDEF12", title: "缺少分页信息" },
      ], { pn: 1 })))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
    )).rejects.toThrow("分页元数据");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat a short page without a total count as a complete snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(videoPage([
      { bvid: "BV1abcDEF12", title: "总数缺失" },
    ], { pn: 1, ps: 30 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
    )).rejects.toThrow("分页元数据");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not turn an unconfirmed empty page into an empty snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(videoPage([], { pn: 1, ps: 30, count: 1 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
    )).rejects.toThrow("分页提前结束");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicitly confirmed empty account", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(videoPage([], { pn: 1, ps: 30, count: 0 })))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
    )).resolves.toMatchObject({ videos: [], mode: "snapshot" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([null, "", false])("rejects an empty account when count is %s instead of an explicit zero", async (count) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(videoPage([], { pn: 1, ps: 30, count })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
    )).rejects.toThrow("分页元数据不完整");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient sidecar response before accepting the page", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: "temporary" }, 503))
      .mockResolvedValueOnce(jsonResponse(videoPage([{
        bvid: "BV1abcDEF12",
        title: "重试后成功",
      }], { pn: 1, ps: 30, count: 1 })))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
    );
    await vi.advanceTimersByTimeAsync(700);

    await expect(pending).resolves.toMatchObject({ videos: [{ title: "重试后成功" }] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves the HTTP status after a detailed transient response exhausts retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "Internal Server Error" }, 500))
      .mockResolvedValueOnce(jsonResponse({ detail: "Internal Server Error" }, 500))
      .mockResolvedValueOnce(jsonResponse({ detail: "Internal Server Error" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    const pending = syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
    );
    const rejection = expect(pending).rejects.toMatchObject({
      message: "Internal Server Error",
      status: 500,
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(2_100);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not mark a non-transient sidecar client error as retryable", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ detail: "Bad Request" }, 400),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
    )).rejects.toMatchObject({
      message: "Bad Request",
      status: 400,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors an already-aborted synchronization signal", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(syncBilibiliCreator(
      "http://127.0.0.1:8001",
      creator,
      syncedAt,
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
