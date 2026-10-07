import { describe, expect, it, vi } from "vitest";

import { migrateFeedState, readFeedState, recoverFeedState } from "@/lib/feed-storage";

const creator = {
  id: "creator-1",
  platform: "bilibili" as const,
  profileUrl: "https://space.bilibili.com/123456",
  name: "哔站博主",
  enabled: true,
};

function video(id: string, bvid: string) {
  return {
    id,
    platform: "bilibili" as const,
    videoUrl: `https://www.bilibili.com/video/${bvid}`,
    creatorId: creator.id,
    title: bvid,
    source: "feed-sync" as const,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function manualVideo(id: string, videoUrl: string, platform: "bilibili" | "douyin" = "bilibili") {
  return {
    ...video(id, "BV1abcdefghi"),
    platform,
    videoUrl,
    title: id,
    source: "manual" as const,
  };
}

describe("feed storage migration", () => {
  it("rejects Bilibili profile aliases that identify the same UID", () => {
    const state = {
      version: 2,
      creators: [
        { ...creator, nameSource: "fallback" },
        { ...creator, id: "creator-alias", profileUrl: "https://www.bilibili.com/space/123456/?spm_id_from=share", nameSource: "fallback" },
      ],
      videos: [],
    };

    expect(migrateFeedState(state)).toBeNull();
    expect(recoverFeedState(state)?.state.creators).toHaveLength(1);
  });

  it("reattaches videos to the retained creator when recovery folds profile aliases", () => {
    const alias = {
      ...creator,
      id: "creator-alias",
      profileUrl: "https://www.bilibili.com/space/123456/?spm_id_from=share",
      nameSource: "fallback" as const,
    };
    const recovered = recoverFeedState({
      version: 2,
      creators: [{ ...creator, nameSource: "fallback" }, alias],
      videos: [
        video("video-primary", "BV1abcdefghi"),
        { ...video("video-alias", "BV1klmnopqrs"), creatorId: alias.id },
      ],
    });

    expect(recovered?.state.creators).toHaveLength(1);
    expect(recovered?.state.videos.map(({ id, creatorId }) => ({ id, creatorId }))).toEqual([
      { id: "sync-bilibili-BV1abcdefghi", creatorId: creator.id },
      { id: "sync-bilibili-BV1klmnopqrs", creatorId: creator.id },
    ]);
  });

  it("keeps a manual video when alias recovery finds the same automatic video", () => {
    const alias = {
      ...creator,
      id: "creator-alias",
      profileUrl: "https://www.bilibili.com/space/123456/?spm_id_from=share",
      nameSource: "fallback" as const,
    };
    const recovered = recoverFeedState({
      version: 2,
      creators: [{ ...creator, nameSource: "fallback" }, alias],
      videos: [
        video("sync-video", "BV1abcdefghi"),
        {
          ...manualVideo("manual-video", "https://m.bilibili.com/video/BV1abcdefghi?p=1&from=share"),
          creatorId: alias.id,
          coverUrl: "https://i0.hdslb.com/example.jpg",
        },
      ],
    });

    expect(recovered?.state.videos).toHaveLength(1);
    expect(recovered?.state.videos[0]).toMatchObject({
      id: "manual-video",
      creatorId: creator.id,
      source: "manual",
      coverUrl: "https://i0.hdslb.com/example.jpg",
    });
  });

  it("keeps recovered IDs unique when the preferred alias ID belongs to another video", () => {
    const otherManual = manualVideo("manual-collision", "https://www.bilibili.com/video/BV1klmnopqrs");
    const aliasManual = manualVideo("manual-collision", "https://m.bilibili.com/video/BV1abcdefghi?p=1&from=share");
    const recovered = recoverFeedState({
      version: 2,
      creators: [{ ...creator, nameSource: "fallback" }],
      videos: [video("old-sync-id", "BV1abcdefghi"), otherManual, aliasManual],
    });
    const recoveredAlias = recovered?.state.videos.find((item) => item.videoUrl.includes("BV1abcdefghi"));

    expect(recovered?.state.videos).toHaveLength(2);
    expect(recovered?.state.videos.map((item) => item.id)).toEqual(expect.arrayContaining([
      "manual-collision",
    ]));
    expect(recoveredAlias?.source).toBe("manual");
    expect(recoveredAlias?.id).not.toBe(otherManual.id);
    expect(recovered && migrateFeedState(recovered.state)).not.toBeNull();
  });

  it("rejects Douyin profile aliases that identify the same user path", () => {
    const douyinCreator = {
      id: "douyin-creator-1",
      platform: "douyin" as const,
      profileUrl: "https://www.douyin.com/user/MS4wLjABAAAA",
      name: "抖音博主",
      enabled: true,
    };

    expect(migrateFeedState({
      version: 2,
      creators: [
        { ...douyinCreator, nameSource: "fallback" },
        { ...douyinCreator, id: "douyin-creator-2", profileUrl: "https://m.iesdouyin.com/user/MS4wLjABAAAA/?from=share", nameSource: "fallback" },
      ],
      videos: [],
    })).toBeNull();
  });

  it("treats Bilibili host and tracking aliases without p as the first part", () => {
    for (const query of ["p=1", "p=0", "p=not-a-number"]) {
      const firstPart = manualVideo("video-1", "https://www.bilibili.com/video/BV1abcdefghi?spm_id_from=share");
      const aliasPart = manualVideo("video-2", `https://m.bilibili.com/video/BV1abcdefghi?${query}#comments`);

      expect(migrateFeedState({
        version: 2,
        creators: [{ ...creator, nameSource: "fallback" }],
        videos: [firstPart, aliasPart],
      })).toBeNull();
    }
  });

  it("keeps distinct valid Bilibili parts as separate videos", () => {
    const firstPart = { ...video("video-1", "BV1abcdefghi"), videoUrl: "https://www.bilibili.com/video/BV1abcdefghi" };
    const secondPart = { ...video("video-2", "BV1abcdefghi"), videoUrl: "https://m.bilibili.com/video/BV1abcdefghi?p=2&spm_id_from=share" };

    expect(migrateFeedState({
      version: 2,
      creators: [{ ...creator, nameSource: "fallback" }],
      videos: [firstPart, secondPart],
    })?.videos).toHaveLength(2);
  });

  it("deduplicates Douyin videos by aweme ID across host and tracking aliases", () => {
    const douyinCreator = {
      id: "douyin-creator-1",
      platform: "douyin" as const,
      profileUrl: "https://www.douyin.com/user/MS4wLjABAAAA",
      name: "抖音博主",
      nameSource: "fallback" as const,
      enabled: true,
    };
    const firstVideo = {
      ...manualVideo("video-1", "https://www.douyin.com/video/7201234567890123456?from=share", "douyin"),
      creatorId: douyinCreator.id,
    };
    const aliasVideo = {
      ...manualVideo("video-2", "https://m.douyin.com/video/7201234567890123456?modal_id=7201234567890123456", "douyin"),
      creatorId: douyinCreator.id,
    };

    expect(migrateFeedState({ version: 2, creators: [douyinCreator], videos: [firstVideo, aliasVideo] })).toBeNull();
  });

  it("migrates a v1 fallback creator to v2 without changing its meaning", () => {
    const migrated = migrateFeedState({ version: 1, creators: [creator], videos: [] });

    expect(migrated).toEqual({
      version: 2,
      creators: [{ ...creator, nameSource: "fallback" }],
      videos: [],
    });
  });

  it("repairs old duplicate feed-sync ids using the platform video ids", () => {
    const recovered = recoverFeedState({
      version: 2,
      creators: [{ ...creator, nameSource: "fallback" }],
      videos: [
        video("legacy-collision", "BV1abcdefghi"),
        video("legacy-collision", "BV1klmnopqrs"),
      ],
    });

    expect(recovered?.state.videos.map((item) => item.id)).toEqual([
      "sync-bilibili-BV1abcdefghi",
      "sync-bilibili-BV1klmnopqrs",
    ]);
    expect(recovered?.repaired).toBe(2);
  });

  it("rejects a backup containing an orphan video instead of silently dropping it", () => {
    const state = {
      version: 2,
      creators: [{ ...creator, nameSource: "fallback" }],
      videos: [{ ...video("video-1", "BV1abcdefghi"), creatorId: "missing" }],
    };

    expect(migrateFeedState(state)).toBeNull();
    expect(recoverFeedState(state)?.state.videos).toEqual([]);
  });

  it("rejects a creator profile hosted on the wrong platform", () => {
    expect(migrateFeedState({
      version: 2,
      creators: [{ ...creator, profileUrl: "https://www.douyin.com/user/example" }],
      videos: [],
    })).toBeNull();
  });

  it("rejects a same-platform video URL when a creator profile is required", () => {
    expect(migrateFeedState({
      version: 2,
      creators: [{ ...creator, profileUrl: "https://www.bilibili.com/video/BV1abcdefghi" }],
      videos: [],
    })).toBeNull();
  });

  it("validates in-memory state without serializing the whole database to a Blob", () => {
    const originalBlob = globalThis.Blob;
    Object.defineProperty(globalThis, "Blob", {
      configurable: true,
      value: class {
        constructor() {
          throw new Error("Blob serialization should not run");
        }
      },
    });
    try {
      expect(migrateFeedState({
        version: 2,
        creators: [{ ...creator, nameSource: "fallback" }],
        videos: [],
      })?.creators).toHaveLength(1);
    } finally {
      Object.defineProperty(globalThis, "Blob", { configurable: true, value: originalBlob });
    }
  });

  it("marks a valid v1 IndexedDB record for one-time v2 rewrite", async () => {
    const originalIndexedDb = globalThis.indexedDB;
    const record = { version: 1, creators: [creator], videos: [], revision: 4 };
    const database = {
      transaction: () => ({
        objectStore: () => ({
          get: () => {
            const request: {
              result?: unknown;
              onsuccess: ((event: Event) => void) | null;
            } = { result: record, onsuccess: null };
            queueMicrotask(() => request.onsuccess?.({} as Event));
            return request;
          },
        }),
      }),
      close: vi.fn(),
    } as unknown as IDBDatabase;
    const indexedDb = {
      open: () => {
        const request: {
          result: IDBDatabase;
          onsuccess: ((event: Event) => void) | null;
          onerror: ((event: Event) => void) | null;
          onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null;
        } = { result: database, onsuccess: null, onerror: null, onupgradeneeded: null };
        queueMicrotask(() => request.onsuccess?.({} as Event));
        return request;
      },
    } as unknown as IDBFactory;
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: indexedDb });
    try {
      await expect(readFeedState()).resolves.toMatchObject({ revision: 4, needsRewrite: true });
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: originalIndexedDb });
    }
  });
});
