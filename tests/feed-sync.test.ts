import { describe, expect, it } from "vitest";

import { applyBilibiliRunLimit, buildSyncBatches, clearSyncErrors, getBilibiliCooldownMs, getDouyinCooldownMs, getKnownDouyinVideoIdsForSync, getRestrictedSyncPlatform, isProviderUnavailableFailure, MAX_BILIBILI_CREATORS_PER_RUN, mergeSyncResponse, RESTRICTION_RETRY_DELAY_MS, type SyncResponse } from "@/lib/feed-sync";
import { MAX_FEED_NAME_LENGTH, MAX_FEED_TITLE_LENGTH, migrateFeedState } from "@/lib/feed-storage";
import type { Creator, FeedState, VideoItem } from "@/lib/feed-types";

const creator: Creator = {
  id: "creator-1",
  platform: "bilibili",
  profileUrl: "https://space.bilibili.com/123",
  name: "Creator",
  enabled: true,
};

function syncedVideo(overrides: Partial<VideoItem> = {}): VideoItem {
  return {
    id: "old-id",
    platform: "bilibili",
    videoUrl: "https://www.bilibili.com/video/BV1old411c7mD",
    creatorId: creator.id,
    title: "Old video",
    source: "feed-sync",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function merge(videos: VideoItem[], response: SyncResponse) {
  const state: FeedState = { version: 2, creators: [creator], videos };
  return mergeSyncResponse(state, [creator], response);
}

describe("mergeSyncResponse", () => {
  it("replaces an old automatic snapshot only after a complete, count-matched result", () => {
    const incoming = syncedVideo({
      id: "new-id",
      videoUrl: "https://www.bilibili.com/video/BV1new411c7mD",
      title: "New video",
    });
    const result = merge([syncedVideo()], {
      syncedAt: "2026-09-13T00:00:00.000Z",
      videos: [incoming],
      results: [{ creatorId: creator.id, status: "success", complete: true, count: 1 }],
    });

    expect(result.videos.map((item) => item.videoUrl)).toEqual([incoming.videoUrl]);
    expect(result.failedCreatorIds).toEqual([]);
    expect(result.creators[0].lastSyncAt).toBe("2026-09-13T00:00:00.000Z");
  });

  it.each(["BV123456", `BV${"a".repeat(32)}`])("keeps a supported BVID boundary %s during snapshot merge", (bvid) => {
    const incoming = syncedVideo({ id: "boundary", videoUrl: `https://www.bilibili.com/video/${bvid}` });
    const result = merge([], {
      syncedAt: "2026-09-13T00:00:00.000Z",
      videos: [incoming],
      results: [{ creatorId: creator.id, status: "success", complete: true, count: 1 }],
    });

    expect(result.failedCreatorIds).toEqual([]);
    expect(result.videos[0].videoUrl).toBe(incoming.videoUrl);
  });

  it.each([
    { complete: false, count: 1, label: "incomplete flag" },
    { complete: true, count: 2, label: "count mismatch" },
  ])("retains the old snapshot on $label", ({ complete, count }) => {
    const old = syncedVideo();
    const result = merge([old], {
      videos: [syncedVideo({ id: "new-id", videoUrl: "https://www.bilibili.com/video/BV1new411c7mD" })],
      results: [{ creatorId: creator.id, status: "success", complete, count }],
    });

    expect(result.videos).toEqual([old]);
    expect(result.failedCreatorIds).toEqual([creator.id]);
    expect(result.creators[0].syncError).toContain("不完整");
  });

  it("preserves a manual record when the same URL appears in a complete snapshot", () => {
    const manual = syncedVideo({
      id: "manual-id",
      videoUrl: "https://www.bilibili.com/video/BV1same411c7mD",
      title: "Manual title",
      source: "manual",
    });
    const result = merge([manual], {
      videos: [syncedVideo({
        id: "sync-id",
        videoUrl: manual.videoUrl,
        title: "Platform title",
        coverUrl: "https://i0.hdslb.com/example.jpg",
      })],
      results: [{ creatorId: creator.id, status: "success", complete: true, count: 1 }],
    });

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]).toMatchObject({ id: manual.id, source: "manual", title: manual.title });
    expect(result.videos[0].coverUrl).toBe("https://i0.hdslb.com/example.jpg");
  });

  it("merges a synchronized video with a manual Bilibili URL alias", () => {
    const manual = syncedVideo({
      id: "manual-id",
      videoUrl: "https://m.bilibili.com/video/BV1same411c7mD?p=1&spm_id_from=share",
      title: "Manual title",
      source: "manual",
    });
    const result = merge([manual], {
      videos: [syncedVideo({
        id: "sync-id",
        videoUrl: "https://www.bilibili.com/video/BV1same411c7mD",
        title: "Platform title",
        coverUrl: "https://i0.hdslb.com/example.jpg",
      })],
      results: [{ creatorId: creator.id, status: "success", complete: true, count: 1 }],
    });

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]).toMatchObject({
      id: "manual-id",
      videoUrl: manual.videoUrl,
      title: "Manual title",
      source: "manual",
      coverUrl: "https://i0.hdslb.com/example.jpg",
    });
    expect(migrateFeedState({ version: 2, creators: [creator], videos: result.videos })).not.toBeNull();
  });

  it("retains the old snapshot when a reported video URL is not a platform video page", () => {
    const old = syncedVideo();
    const result = merge([old], {
      videos: [syncedVideo({
        id: "invalid-id",
        videoUrl: "https://space.bilibili.com/123",
      })],
      results: [{ creatorId: creator.id, status: "success", complete: true, count: 1 }],
    });

    expect(result.videos).toEqual([old]);
    expect(result.failedCreatorIds).toEqual([creator.id]);
  });

  it("bounds platform text and drops invalid optional URLs and dates before persistence", () => {
    const fallbackCreator: Creator = { ...creator, name: "哔站博主", nameSource: "fallback" };
    const incoming = syncedVideo({
      id: "new-id",
      videoUrl: "https://www.bilibili.com/video/BV1new411c7mD",
      title: "t".repeat(MAX_FEED_TITLE_LENGTH + 20),
      coverUrl: "javascript:alert(1)",
      publishedAt: "not-a-date",
    });
    const result = mergeSyncResponse({
      creators: [fallbackCreator],
      videos: [syncedVideo()],
    }, [fallbackCreator], {
      syncedAt: "2026-09-13T00:00:00.000Z",
      videos: [incoming],
      results: [{
        creatorId: creator.id,
        status: "success",
        complete: true,
        count: 1,
        profile: {
          name: "n".repeat(MAX_FEED_NAME_LENGTH + 20),
          avatarUrl: "data:image/png;base64,invalid",
        },
      }],
    });

    expect(result.videos[0].title).toHaveLength(MAX_FEED_TITLE_LENGTH);
    expect(result.videos[0].coverUrl).toBeUndefined();
    expect(result.videos[0].publishedAt).toBeUndefined();
    expect(result.creators[0].name).toHaveLength(MAX_FEED_NAME_LENGTH);
    expect(result.creators[0].avatarUrl).toBeUndefined();
  });
});

describe("buildSyncBatches", () => {
  it("keeps Douyin batches to three creators and paces Bilibili one creator at a time", () => {
    const creators: Creator[] = [
      ...Array.from({ length: 11 }, (_, index) => ({
        ...creator,
        id: `bilibili-${index}`,
      })),
      { ...creator, id: "douyin-1", platform: "douyin", profileUrl: "https://www.douyin.com/user/1" },
      { ...creator, id: "douyin-2", platform: "douyin", profileUrl: "https://www.douyin.com/user/2" },
    ];

    expect(buildSyncBatches(creators).map((batch) => batch.map((item) => item.id))).toEqual([
      ...Array.from({ length: 11 }, (_, index) => [`bilibili-${index}`]),
      ["douyin-1", "douyin-2"],
    ]);
  });

  it("recognizes platform restrictions without treating transient provider outages as rate limits", () => {
    const bilibili = { ...creator, id: "bili" };
    const douyin = { ...creator, id: "douyin", platform: "douyin" as const };
    expect(getRestrictedSyncPlatform([bilibili], {
      results: [{ creatorId: "bili", status: "error", failureCode: "bilibili_rate_limited" }],
    })).toBe("bilibili");
    expect(getRestrictedSyncPlatform([douyin], {
      results: [{ creatorId: "douyin", status: "error", failureCode: "douyin_circuit_open" }],
    })).toBe("douyin");
    expect(getRestrictedSyncPlatform([bilibili], {
      results: [{ creatorId: "bili", status: "error", failureCode: "provider_unavailable" }],
    })).toBeNull();
  });

  it("detects a provider outage without confusing it with a per-creator failure", () => {
    expect(isProviderUnavailableFailure({
      results: [{ creatorId: "a", status: "error", failureCode: "provider_unavailable" }],
    })).toBe(true);
    expect(isProviderUnavailableFailure({
      results: [
        { creatorId: "a", status: "error", failureCode: "provider_unavailable" },
        { creatorId: "b", status: "success" },
      ],
    })).toBe(false);
    expect(isProviderUnavailableFailure({
      results: [{ creatorId: "a", status: "error", failureCode: "bilibili_rate_limited" }],
    })).toBe(false);
    expect(isProviderUnavailableFailure({ results: [] })).toBe(false);
  });

  it("does not mix adjacent platforms in a batch", () => {
    const creators: Creator[] = [
      creator,
      { ...creator, id: "douyin-1", platform: "douyin", profileUrl: "https://www.douyin.com/user/1" },
      { ...creator, id: "bilibili-2" },
    ];

    expect(buildSyncBatches(creators).map((batch) => batch.map((item) => item.platform))).toEqual([
      ["bilibili"],
      ["douyin"],
      ["bilibili"],
    ]);
  });

  it("keeps a failed Douyin creator on a fresh snapshot path for the next retry", () => {
    const failed = {
      id: "douyin-failed",
      platform: "douyin" as const,
      profileUrl: "https://www.douyin.com/user/failed",
      name: "Failed creator",
      enabled: true,
      syncError: "抖音返回空白投稿数据",
    };
    const existing = {
      id: "sync-douyin-old",
      platform: "douyin" as const,
      videoUrl: "https://www.douyin.com/video/1234567890123456789",
      creatorId: failed.id,
      title: "Old video",
      source: "feed-sync" as const,
      createdAt: "2026-09-01T00:00:00.000Z",
    };

    expect(getKnownDouyinVideoIdsForSync(failed, [existing])).toEqual([]);
    expect(getKnownDouyinVideoIdsForSync({ ...failed, syncError: undefined }, [existing])).toEqual([
      "1234567890123456789",
    ]);
  });
});

describe("Douyin sync pacing", () => {
  it("keeps the cooldown within the configured 8-14 second range", () => {
    expect(getDouyinCooldownMs(() => 0)).toBe(8_000);
    expect(getDouyinCooldownMs(() => 1 - Number.EPSILON)).toBe(14_000);
  });
});

describe("Bilibili pacing", () => {
  it("spaces creators by 3-5 seconds and backs off once on a rate limit", () => {
    expect(getBilibiliCooldownMs(() => 0)).toBe(3_000);
    expect(getBilibiliCooldownMs(() => 1 - Number.EPSILON)).toBe(5_000);
    expect(RESTRICTION_RETRY_DELAY_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("applyBilibiliRunLimit", () => {
  const bilibili = (id: string, overrides: Partial<Creator> = {}): Creator => ({
    ...creator,
    id,
    name: id,
    ...overrides,
  });

  it("keeps a short Bilibili list untouched and ignores other platforms", () => {
    const targets = [
      bilibili("b1"),
      { ...creator, id: "d1", platform: "douyin" as const, profileUrl: "https://www.douyin.com/user/d1" },
      bilibili("b2"),
    ];

    const { planned, deferred } = applyBilibiliRunLimit(targets);

    expect(planned.map((item) => item.id)).toEqual(["b1", "d1", "b2"]);
    expect(deferred).toEqual([]);
  });

  it("defers the least urgent Bilibili creators beyond the per-run cap", () => {
    const targets = Array.from({ length: MAX_BILIBILI_CREATORS_PER_RUN + 5 }, (_, index) => bilibili(`b${index}`, {
      // b0..b4 already failed, b5..b29 never synced, the rest synced long ago.
      ...(index < 5 ? { syncError: "风控校验失败" } : {}),
      ...(index >= 30 ? { lastSyncAt: "2026-10-01T00:00:00.000Z" } : {}),
    }));

    const { planned, deferred } = applyBilibiliRunLimit(targets);

    expect(planned).toHaveLength(MAX_BILIBILI_CREATORS_PER_RUN);
    expect(deferred.map((item) => item.id)).toEqual(["b50", "b51", "b52", "b53", "b54"]);
    // Failed records are scheduled first so retries make progress.
    expect(planned.slice(0, 5).map((item) => item.id)).toEqual(["b0", "b1", "b2", "b3", "b4"]);
  });
});

describe("clearSyncErrors", () => {
  const restrictedError = "风控校验失败";

  it("clears stale errors for records a new run skips", () => {
    const state = {
      creators: [
        { ...creator, id: "skipped", syncError: restrictedError },
        { ...creator, id: "attempted", syncError: restrictedError },
        { ...creator, id: "healthy" },
      ],
      videos: [],
    };

    const cleared = clearSyncErrors(state, ["skipped"]);

    expect(cleared.creators.map((item) => item.syncError)).toEqual([undefined, restrictedError, undefined]);
    expect(cleared.creators[0].id).toBe("skipped");
  });

  it("returns the same state when nothing needs clearing", () => {
    const state = { creators: [{ ...creator, id: "healthy" }], videos: [] };
    expect(clearSyncErrors(state, ["healthy"])).toBe(state);
    expect(clearSyncErrors(state, ["missing"])).toBe(state);
  });
});
