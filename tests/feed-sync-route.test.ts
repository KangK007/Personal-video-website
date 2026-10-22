import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openDouyinBrowserSession: vi.fn(),
  probeSidecar: vi.fn(),
  syncBilibiliCreator: vi.fn(),
  sidecarBaseUrl: null as string | null,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/douyin-browser", () => ({
  DouyinSyncError: class DouyinSyncError extends Error {
    code: string;

    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
  getDouyinFailureCode: (error: unknown) => (
    error instanceof Error && "code" in error ? error.code : undefined
  ),
  isRetryableDouyinError: () => false,
  openDouyinBrowserSession: mocks.openDouyinBrowserSession,
}));

vi.mock("@/lib/server/bilibili-sync", () => ({
  getSidecarBaseUrl: () => mocks.sidecarBaseUrl,
  isRetryableSidecarError: (error: unknown) => (
    error instanceof Error
    && "retryable" in error
    && error.retryable === true
    && !("status" in error && error.status === 429)
  ),
  probeSidecar: mocks.probeSidecar,
  syncBilibiliCreator: mocks.syncBilibiliCreator,
}));

let POST: typeof import("@/app/api/feed/sync/route").POST;

beforeAll(async () => {
  ({ POST } = await import("@/app/api/feed/sync/route"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.openDouyinBrowserSession.mockReset();
  mocks.probeSidecar.mockReset();
  mocks.syncBilibiliCreator.mockReset();
  mocks.sidecarBaseUrl = null;
});

function creator(id: string) {
  return {
    id,
    platform: "douyin",
    profileUrl: `https://www.douyin.com/user/${id}`,
    name: `博主 ${id}`,
  };
}

function syncRequest(creators: unknown[], signal?: AbortSignal) {
  return new Request("http://127.0.0.1:3000/api/feed/sync", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ creators }),
    signal,
  });
}

function posts(videoId = "1234567890123456789") {
  return {
    payload: {
      status_code: 0,
      aweme_list: [{ aweme_id: videoId, desc: "测试投稿", video: { duration: 1_000 } }],
    },
    mode: "snapshot" as const,
  };
}

describe("feed sync route cancellation and cleanup", () => {
  it("stops requesting Bilibili creators after a rate-limit response but continues Douyin", async () => {
    mocks.sidecarBaseUrl = "http://127.0.0.1:8001";
    mocks.probeSidecar.mockResolvedValue(undefined);
    mocks.syncBilibiliCreator.mockRejectedValue(new Error("风控校验失败"));
    const fetchUserPosts = vi.fn().mockResolvedValue(posts());
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.openDouyinBrowserSession.mockResolvedValue({ fetchUserPosts, close });

    const response = await POST(syncRequest([
      { id: "bili-1", platform: "bilibili", profileUrl: "https://space.bilibili.com/123456", name: "博主一" },
      { id: "bili-2", platform: "bilibili", profileUrl: "https://space.bilibili.com/654321", name: "博主二" },
      creator("douyin-1"),
    ]));
    const body = await response.json() as { results: Array<{ failureCode?: string; status: string }> };

    expect(response.status).toBe(200);
    expect(body.results.map((result) => result.failureCode)).toEqual([
      "bilibili_rate_limited", "bilibili_circuit_open", undefined,
    ]);
    expect(body.results[2].status).toBe("success");
    expect(mocks.syncBilibiliCreator).toHaveBeenCalledTimes(1);
    expect(fetchUserPosts).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("marks transient sidecar probe failures as retryable provider failures", async () => {
    mocks.sidecarBaseUrl = "http://127.0.0.1:8001";
    mocks.probeSidecar.mockRejectedValue(new Error("哔站本机抓取服务未启动或无法连接"));

    const response = await POST(syncRequest([{
      id: "bili-1",
      platform: "bilibili",
      profileUrl: "https://space.bilibili.com/123456",
      name: "博主一",
    }]));
    const body = await response.json() as { results: Array<{ failureCode?: string }> };

    expect(response.status).toBe(502);
    expect(body.results[0].failureCode).toBe("provider_unavailable");
  });

  it("keeps a detailed sidecar probe 5xx retryable after fan-out to creators", async () => {
    mocks.sidecarBaseUrl = "http://127.0.0.1:8001";
    mocks.probeSidecar.mockRejectedValue(
      Object.assign(new Error("Internal Server Error"), { status: 500, retryable: true }),
    );

    const response = await POST(syncRequest([{
      id: "bili-1",
      platform: "bilibili",
      profileUrl: "https://space.bilibili.com/123456",
      name: "博主一",
    }]));
    const body = await response.json() as {
      results: Array<{ failureCode?: string; message?: string }>;
    };

    expect(response.status).toBe(502);
    expect(body.results[0]).toMatchObject({
      failureCode: "provider_unavailable",
      message: "Internal Server Error",
    });
    expect(mocks.syncBilibiliCreator).not.toHaveBeenCalled();
  });

  it("does not mark a missing sidecar configuration as a transient failure", async () => {
    const response = await POST(syncRequest([{
      id: "bili-1",
      platform: "bilibili",
      profileUrl: "https://space.bilibili.com/123456",
      name: "博主一",
    }]));
    const body = await response.json() as { results: Array<{ failureCode?: string; message?: string }> };

    expect(response.status).toBe(502);
    expect(body.results[0].failureCode).toBeUndefined();
    expect(body.results[0].message).toContain("未配置哔站本机抓取服务");
  });

  it("marks a detailed exhausted sidecar 5xx as a retryable provider failure", async () => {
    mocks.sidecarBaseUrl = "http://127.0.0.1:8001";
    mocks.probeSidecar.mockResolvedValue(undefined);
    mocks.syncBilibiliCreator.mockRejectedValue(
      Object.assign(new Error("Internal Server Error"), { status: 500, retryable: true }),
    );

    const response = await POST(syncRequest([{
      id: "bili-1",
      platform: "bilibili",
      profileUrl: "https://space.bilibili.com/123456",
      name: "博主一",
    }]));
    const body = await response.json() as {
      results: Array<{ failureCode?: string; message?: string }>;
    };

    expect(response.status).toBe(502);
    expect(body.results[0]).toMatchObject({
      failureCode: "provider_unavailable",
      message: "Internal Server Error",
    });
  });

  it("does not classify a sidecar 4xx as a retryable provider failure", async () => {
    mocks.sidecarBaseUrl = "http://127.0.0.1:8001";
    mocks.probeSidecar.mockResolvedValue(undefined);
    mocks.syncBilibiliCreator.mockRejectedValue(
      Object.assign(new Error("Bad Request"), { status: 400, retryable: false }),
    );

    const response = await POST(syncRequest([{
      id: "bili-1",
      platform: "bilibili",
      profileUrl: "https://space.bilibili.com/123456",
      name: "博主一",
    }]));
    const body = await response.json() as { results: Array<{ failureCode?: string; message?: string }> };

    expect(body.results[0]).toMatchObject({ message: "Bad Request" });
    expect(body.results[0].failureCode).toBeUndefined();
  });

  it("treats a sidecar 429 as a platform restriction without immediate retry", async () => {
    mocks.sidecarBaseUrl = "http://127.0.0.1:8001";
    mocks.probeSidecar.mockResolvedValue(undefined);
    mocks.syncBilibiliCreator.mockRejectedValue(
      Object.assign(new Error("Too Many Requests"), { status: 429, retryable: false }),
    );

    const response = await POST(syncRequest([{
      id: "bili-1",
      platform: "bilibili",
      profileUrl: "https://space.bilibili.com/123456",
      name: "博主一",
    }]));
    const body = await response.json() as { results: Array<{ failureCode?: string; message?: string }> };

    expect(body.results[0]).toMatchObject({ message: "Too Many Requests" });
    expect(body.results[0].failureCode).toBe("bilibili_rate_limited");
  });

  it("does not classify Douyin pagination timeouts as local provider failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    mocks.openDouyinBrowserSession.mockResolvedValue({
      fetchUserPosts: vi.fn().mockRejectedValue(new Error("抖音分页加载超时，未完整同步")),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const pending = POST(syncRequest([creator("douyin-1")]));
    await vi.advanceTimersByTimeAsync(45_000);
    const response = await pending;
    const body = await response.json() as { results: Array<{ failureCode?: string }> };

    expect(response.status).toBe(502);
    expect(body.results[0].failureCode).toBeUndefined();
  });

  it("rejects two creator IDs that point to the same profile", async () => {
    const response = await POST(syncRequest([
      creator("same-user"),
      { ...creator("alias-id"), profileUrl: "https://m.iesdouyin.com/user/same-user/?from=share" },
    ]));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "关注名单中存在无效或重复的博主数据" });
    expect(mocks.openDouyinBrowserSession).not.toHaveBeenCalled();
  });

  it("rejects Bilibili profile host aliases before contacting the sidecar", async () => {
    const response = await POST(syncRequest([
      { id: "bili-1", platform: "bilibili", profileUrl: "https://space.bilibili.com/123456", name: "博主一" },
      { id: "bili-2", platform: "bilibili", profileUrl: "https://www.bilibili.com/space/123456/?from=share", name: "博主二" },
    ]));

    expect(response.status).toBe(400);
    expect(mocks.openDouyinBrowserSession).not.toHaveBeenCalled();
  });

  it("returns a cancellation response when the request is aborted during Douyin cooldown", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    const controller = new AbortController();
    let resolveFirstFetch!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      resolveFirstFetch = resolve;
    });
    const fetchUserPosts = vi.fn(async () => {
      if (fetchUserPosts.mock.calls.length === 1) {
        setTimeout(() => controller.abort(), 1_000);
        resolveFirstFetch();
      }
      return posts();
    });
    mocks.openDouyinBrowserSession.mockResolvedValue({
      fetchUserPosts,
      close: vi.fn().mockResolvedValue(undefined),
    });

    const pending = POST(syncRequest([creator("first"), creator("second")], controller.signal));
    await firstFetchStarted;
    await vi.advanceTimersByTimeAsync(1_000);

    const response = await pending;
    expect(response.status).toBe(499);
    await expect(response.json()).resolves.toEqual({ error: "同步已取消" });
    expect(fetchUserPosts).toHaveBeenCalledTimes(1);
  });

  it("preserves the completed sync response when closing the browser session fails", async () => {
    mocks.openDouyinBrowserSession.mockResolvedValue({
      fetchUserPosts: vi.fn().mockResolvedValue(posts()),
      close: vi.fn().mockRejectedValue(new Error("browser close failed")),
    });

    const response = await POST(syncRequest([creator("only") ]));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      configured: true,
      videos: [{ title: "测试投稿" }],
      results: [{ creatorId: "only", status: "success", complete: true, count: 1 }],
    });
  });

  it("reports not-configured while keeping the accurate per-creator Douyin message", async () => {
    mocks.openDouyinBrowserSession.mockRejectedValue(
      new Error("未配置抖音 Cookie，请重新运行本机抓取服务配置脚本"),
    );

    const response = await POST(syncRequest([creator("only")]));
    const body = await response.json() as { configured: boolean; results: Array<{ message?: string }> };

    // The client shows results[].message when results are present, so the setup
    // guidance must survive instead of being replaced by a generic sidecar message.
    expect(response.status).toBe(502);
    expect(body.configured).toBe(false);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].message).toContain("抖音 Cookie");
  });

  it("rejects a Douyin post whose aweme id is too short to form a video URL", async () => {
    mocks.openDouyinBrowserSession.mockResolvedValue({
      fetchUserPosts: vi.fn().mockResolvedValue(posts("12345")),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const response = await POST(syncRequest([creator("only")]));
    const body = await response.json() as { videos: unknown[]; results: Array<{ status: string; message?: string }> };

    expect(body.videos).toEqual([]);
    expect(body.results[0]).toMatchObject({
      status: "error",
      message: expect.stringContaining("缺少有效作品 ID"),
    });
  });
});
