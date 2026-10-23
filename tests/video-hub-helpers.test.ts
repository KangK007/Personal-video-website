import { describe, expect, it } from "vitest";

import { countFollowingStatuses, countPlatforms } from "@/components/video-hub/helpers";
import type { Creator, Platform, VideoItem } from "@/lib/feed-types";

function creator(
  id: string,
  platform: Platform,
  overrides: Partial<Creator> = {},
): Creator {
  return {
    id,
    platform,
    profileUrl: platform === "douyin" ? `https://www.douyin.com/user/${id}` : `https://space.bilibili.com/${id}`,
    name: `博主 ${id}`,
    enabled: true,
    ...overrides,
  };
}

function video(id: string, platform: Platform, creatorId: string): VideoItem {
  return {
    id,
    platform,
    videoUrl: platform === "douyin" ? `https://www.douyin.com/video/${id}` : `https://www.bilibili.com/video/${id}`,
    creatorId,
    title: `视频 ${id}`,
    source: "feed-sync",
    createdAt: "2026-10-22T00:00:00.000Z",
  };
}

describe("tab counts", () => {
  it("counts platforms inside the other active filters", () => {
    const items = [
      video("1", "douyin", "a"),
      video("2", "bilibili", "b"),
      video("3", "bilibili", "b"),
    ];

    expect(countPlatforms(items)).toEqual({ all: 3, douyin: 1, bilibili: 2 });
    expect(countPlatforms(items, (item) => item.creatorId === "b"))
      .toEqual({ all: 2, douyin: 0, bilibili: 2 });
  });

  it("counts creator statuses inside the other active filters", () => {
    const creators = [
      creator("a", "douyin", { lastSyncAt: "2026-10-22T00:00:00.000Z" }),
      creator("b", "bilibili", { enabled: false, syncError: "风控校验失败" }),
      creator("c", "bilibili"),
    ];

    expect(countFollowingStatuses(creators)).toEqual({ all: 3, unsynced: 1, failed: 1, paused: 1 });
    expect(countFollowingStatuses(creators, (item) => item.platform === "bilibili"))
      .toEqual({ all: 2, unsynced: 1, failed: 1, paused: 1 });
  });
});
