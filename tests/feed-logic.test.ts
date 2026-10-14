import { describe, expect, it } from "vitest";

import {
  isRecentVideo,
  parsePublishedAt,
  RECENT_WINDOW_MS,
  sortVideos,
} from "@/lib/feed-logic";
import type { VideoItem } from "@/lib/feed-types";

function video(overrides: Partial<VideoItem>): VideoItem {
  return {
    id: overrides.id ?? "video",
    platform: overrides.platform ?? "bilibili",
    videoUrl: overrides.videoUrl ?? "https://www.bilibili.com/video/BV1xx411c7mD",
    creatorId: overrides.creatorId ?? "creator",
    title: overrides.title ?? "title",
    source: overrides.source ?? "feed-sync",
    createdAt: overrides.createdAt ?? "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("parsePublishedAt", () => {
  it("parses a valid local date-only value", () => {
    const parsed = parsePublishedAt("2026-09-13");

    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(8);
    expect(parsed?.getDate()).toBe(13);
  });

  it("rejects invalid dates", () => {
    expect(parsePublishedAt("2026-02-30")).toBeNull();
    expect(parsePublishedAt("not-a-date")).toBeNull();
    expect(parsePublishedAt()).toBeNull();
  });
});

describe("isRecentVideo", () => {
  const now = Date.parse("2026-09-13T12:00:00.000Z");

  it("uses an open lower boundary for the rolling seven-day window", () => {
    expect(isRecentVideo(video({ publishedAt: new Date(now - RECENT_WINDOW_MS).toISOString() }), now)).toBe(false);
    expect(isRecentVideo(video({ publishedAt: new Date(now - RECENT_WINDOW_MS + 1).toISOString() }), now)).toBe(true);
  });

  it("excludes future and unknown publication times", () => {
    expect(isRecentVideo(video({ publishedAt: new Date(now + 1).toISOString() }), now)).toBe(false);
    expect(isRecentVideo(video({ publishedAt: "invalid" }), now)).toBe(false);
    expect(isRecentVideo(video({ publishedAt: undefined }), now)).toBe(false);
  });
});

describe("sortVideos", () => {
  it("orders valid publication times newest first and unknown times last", () => {
    const result = sortVideos([
      video({ id: "unknown", videoUrl: "https://www.bilibili.com/video/BV1unknown", publishedAt: undefined }),
      video({ id: "older", videoUrl: "https://www.bilibili.com/video/BV1older", publishedAt: "2026-09-10T00:00:00.000Z" }),
      video({ id: "newer", videoUrl: "https://www.bilibili.com/video/BV1newer", publishedAt: "2026-09-12T00:00:00.000Z" }),
    ]);

    expect(result.map((item) => item.id)).toEqual(["newer", "older", "unknown"]);
  });

  it("breaks ties between unknown dates by creation time instead of dropping them", () => {
    const result = sortVideos([
      video({
        id: "unknown-older",
        videoUrl: "https://www.bilibili.com/video/BV1unknown1",
        publishedAt: undefined,
        createdAt: "2026-09-01T00:00:00.000Z",
      }),
      video({
        id: "unknown-newer",
        videoUrl: "https://www.bilibili.com/video/BV1unknown2",
        publishedAt: undefined,
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    ]);

    expect(result.map((item) => item.id)).toEqual(["unknown-newer", "unknown-older"]);
  });
});
