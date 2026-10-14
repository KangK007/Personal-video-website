import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseDouyinPostPayload } from "@/lib/douyin-browser";

describe("parseDouyinPostPayload", () => {
  it("rejects an empty post list so it cannot replace a cached snapshot", () => {
    expect(() => parseDouyinPostPayload(
      JSON.stringify({ status_code: 0, aweme_list: [] }),
      200,
    )).toThrow("未确认结束的空投稿列表");
  });

  it("accepts an explicitly complete empty post list", () => {
    expect(parseDouyinPostPayload(
      JSON.stringify({ status_code: 0, aweme_list: [], has_more: 0 }),
      200,
    ).items).toEqual([]);
  });

  it("rejects an empty page that claims there are more posts", () => {
    expect(() => parseDouyinPostPayload(
      JSON.stringify({ status_code: 0, aweme_list: [], has_more: 1 }),
      200,
    )).toThrow("未确认结束的空投稿列表");
  });

  it("rejects a post without an ID instead of silently dropping it", () => {
    expect(() => parseDouyinPostPayload(
      JSON.stringify({ status_code: 0, aweme_list: [{ desc: "缺少作品 ID" }], has_more: 0 }),
      200,
    )).toThrow("作品 ID");
  });

  it("accepts a non-empty list with numeric post IDs", () => {
    expect(parseDouyinPostPayload(
      JSON.stringify({ status_code: 0, aweme_list: [{ aweme_id: "1234567890123" }], has_more: 0 }),
      200,
    ).items).toHaveLength(1);
  });

  it("rejects a non-empty list without pagination completeness metadata", () => {
    expect(() => parseDouyinPostPayload(
      JSON.stringify({ status_code: 0, aweme_list: [{ aweme_id: "1234567890123" }] }),
      200,
    )).toThrow("分页状态缺失");
  });

  it("rejects an invalid pagination value before replacing cached posts", () => {
    expect(() => parseDouyinPostPayload(
      JSON.stringify({ status_code: 0, aweme_list: [{ aweme_id: "1234567890123" }], has_more: 2 }),
      200,
    )).toThrow("分页状态缺失");
  });
});
