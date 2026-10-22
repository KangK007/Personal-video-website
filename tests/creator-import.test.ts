import { describe, expect, it } from "vitest";

import {
  MAX_CREATOR_IMPORT_LINES,
  appendUniqueCreators,
  appendUniqueVideo,
  isResolvableShortVideoLink,
  normalizeOptionalMediaUrl,
  parseCreatorLines,
  sameEntityIds,
} from "@/components/video-hub/helpers";
import type { Creator, VideoItem } from "@/lib/feed-types";

describe("parseCreatorLines", () => {
  it("支持链接前后的博主昵称", () => {
    const parsed = parseCreatorLines([
      "摄影博主 https://www.douyin.com/user/MS4wLjABAAAAexample",
      "https://space.bilibili.com/123456\t科普作者",
    ].join("\n"));

    expect(parsed.entries).toEqual([
      {
        platform: "douyin",
        profileUrl: "https://www.douyin.com/user/MS4wLjABAAAAexample",
        name: "摄影博主",
        nameSource: "manual",
      },
      {
        platform: "bilibili",
        profileUrl: "https://space.bilibili.com/123456",
        name: "科普作者",
        nameSource: "manual",
      },
    ]);
    expect(parsed.invalidLines).toEqual([]);
  });

  it("记录同一主页的重复行", () => {
    const parsed = parseCreatorLines([
      "https://space.bilibili.com/123456",
      "https://space.bilibili.com/123456",
    ].join("\n"));

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.duplicateLines).toEqual([2]);
  });

  it("按规范化身份识别 Bilibili 主页别名", () => {
    const parsed = parseCreatorLines([
      "https://space.bilibili.com/123456",
      "https://www.bilibili.com/space/123456/?spm_id_from=share",
    ].join("\n"));

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.duplicateLines).toEqual([2]);
  });

  it("在当前列表中原子去重博主追加", () => {
    const current: Creator[] = [{
      id: "creator-1",
      platform: "bilibili",
      profileUrl: "https://space.bilibili.com/123456",
      name: "已有博主",
      enabled: true,
    }];

    const result = appendUniqueCreators(current, [{
      platform: "bilibili",
      profileUrl: "https://www.bilibili.com/space/123456/?spm_id_from=share",
      name: "重复博主",
      nameSource: "manual",
    }], () => "creator-2");

    expect(result.added).toBe(0);
    expect(result.next).toBe(current);
  });

  it("重复导入时保留已有博主的昵称来源和暂停状态", () => {
    const existing: Creator = {
      id: "creator-1",
      platform: "bilibili",
      profileUrl: "https://space.bilibili.com/123456",
      name: "平台原昵称",
      nameSource: "platform",
      enabled: false,
      lastSyncAt: "2026-10-20T00:00:00.000Z",
      syncError: "上次同步失败",
    };
    const current = [existing];
    const result = appendUniqueCreators(current, [{
      platform: "bilibili",
      profileUrl: "https://space.bilibili.com/123456",
      name: "导入的新昵称",
      nameSource: "manual",
    }], () => "creator-2");

    expect(result.added).toBe(0);
    expect(result.next).toBe(current);
    expect(result.next[0]).toEqual(existing);
  });

  it("在当前列表中原子去重视频追加", () => {
    const current: VideoItem[] = [{
      id: "video-1",
      platform: "bilibili",
      videoUrl: "https://www.bilibili.com/video/BV1abcdefghi",
      creatorId: "creator-1",
      title: "已有视频",
      source: "manual",
      createdAt: "2026-10-01T00:00:00.000Z",
    }];
    const duplicate = { ...current[0], id: "video-2", videoUrl: "https://m.bilibili.com/video/BV1abcdefghi?p=1" };

    const result = appendUniqueVideo(current, duplicate);

    expect(result.added).toBe(false);
    expect(result.next).toBe(current);
  });

  it("只允许在撤销前的数据集合未变化时恢复", () => {
    const expected = new Set(["creator-1"]);
    expect(sameEntityIds([{ id: "creator-1" }], expected)).toBe(true);
    expect(sameEntityIds([{ id: "creator-1" }, { id: "creator-2" }], expected)).toBe(false);
    expect(sameEntityIds([{ id: "creator-1" }, { id: "creator-1" }], new Set(["creator-1", "creator-2"]))).toBe(false);
  });

  it("拒绝无效的可选媒体链接并规范化有效链接", () => {
    expect(normalizeOptionalMediaUrl("   ")).toBe("");
    expect(normalizeOptionalMediaUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeOptionalMediaUrl("https://cdn.example.com/cover.jpg#frame")).toBe("https://cdn.example.com/cover.jpg#frame");
  });

  it("报告无法识别的行", () => {
    const parsed = parseCreatorLines("not-a-profile\nhttps://example.com/user/1");

    expect(parsed.entries).toEqual([]);
    expect(parsed.invalidLines).toEqual([1, 2]);
  });

  it("不把同平台视频链接当作博主主页", () => {
    const parsed = parseCreatorLines([
      "https://www.bilibili.com/video/BV1abcdefghi",
      "https://www.douyin.com/video/1234567890123456789",
    ].join("\n"));

    expect(parsed.entries).toEqual([]);
    expect(parsed.invalidLines).toEqual([1, 2]);
  });

  it("超过单次行数上限时停止继续解析", () => {
    const lines = Array.from(
      { length: MAX_CREATOR_IMPORT_LINES + 1 },
      (_, index) => `https://space.bilibili.com/${index + 1}`,
    );
    const parsed = parseCreatorLines(lines.join("\n"));

    expect(parsed.entries).toHaveLength(MAX_CREATOR_IMPORT_LINES);
    expect(parsed.limitExceeded).toBe(true);
  });

  it("不把空行和结尾换行计入单次行数上限", () => {
    const lines = Array.from(
      { length: MAX_CREATOR_IMPORT_LINES },
      (_, index) => `https://space.bilibili.com/${index + 1}`,
    );
    const parsed = parseCreatorLines(`${lines.join("\n\n")}\n`);

    expect(parsed.limitExceeded).toBe(false);
    expect(parsed.entries).toHaveLength(MAX_CREATOR_IMPORT_LINES);
  });

  it("忽略以空格分隔的表头行并保留以表头词开头的昵称", () => {
    const parsed = parseCreatorLines([
      "主页 https://space.bilibili.com/123456",
      "链接: https://space.bilibili.com/654321",
      "名称",
      "主页君 https://space.bilibili.com/111111",
    ].join("\n"));

    expect(parsed.entries.map((entry) => entry.name)).toEqual(["主页君"]);
    expect(parsed.invalidLines).toEqual([]);
  });
});

describe("isResolvableShortVideoLink", () => {
  it("识别可分平台的分享短链接", () => {
    expect(isResolvableShortVideoLink("https://b23.tv/Abc_123")).toBe(true);
    expect(isResolvableShortVideoLink("https://v.douyin.com/iRxYaBc/")).toBe(true);
    expect(isResolvableShortVideoLink("https://www.bilibili.com/video/BV1abcdefghi")).toBe(false);
    expect(isResolvableShortVideoLink("https://b23.tv/Abc_123/extra/path")).toBe(false);
    expect(isResolvableShortVideoLink("not-a-url")).toBe(false);
  });
});
