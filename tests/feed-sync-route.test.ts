import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openDouyinBrowserSession: vi.fn(),
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
  getSidecarBaseUrl: () => null,
  probeSidecar: vi.fn(),
  syncBilibiliCreator: vi.fn(),
}));

let POST: typeof import("@/app/api/feed/sync/route").POST;

beforeAll(async () => {
  ({ POST } = await import("@/app/api/feed/sync/route"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.openDouyinBrowserSession.mockReset();
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
      videos: [{ title: "测试投稿" }],
      results: [{ creatorId: "only", status: "success", complete: true, count: 1 }],
    });
  });
});
