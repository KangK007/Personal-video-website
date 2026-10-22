import { describe, expect, it } from "vitest";

import {
  followingKey,
  followingText,
  makeFollowingFile,
  parseFollowingFile,
  readFollowingStream,
  type FollowingCreator,
} from "@/lib/following-list";

const douyin: FollowingCreator = {
  platform: "douyin",
  platformUserId: "sec_abc",
  name: "摄影\t作者",
  profileUrl: "https://www.douyin.com/user/sec_abc",
};

describe("following list format", () => {
  it("exports stable TXT rows and deduplicates imported JSON records", () => {
    const file = makeFollowingFile([douyin, { ...douyin, name: "重复记录" }], [{ platform: "douyin", status: "complete", received: 1, total: 1, invalidCount: 0 }]);
    const parsed = parseFollowingFile(file);
    expect(parsed.creators).toHaveLength(1);
    expect(followingKey(parsed.creators[0])).toBe("douyin:sec_abc");
    expect(followingText(parsed.creators)).toBe("https://www.douyin.com/user/sec_abc\t摄影 作者");
  });

  it("rejects the normal whole-site backup format", () => {
    expect(() => parseFollowingFile({ version: 2, creators: [], videos: [] })).toThrow("following-list");
  });

  it("rejects a complete result whose count does not match", () => {
    expect(() => parseFollowingFile(makeFollowingFile([douyin], [{ platform: "douyin", status: "complete", received: 1, total: 2, invalidCount: 0 }]))).toThrow("名单文件格式无效");
  });

  it("reads NDJSON split across UTF-8 chunks", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const text = JSON.stringify({ type: "page", platform: "douyin", creators: [douyin], received: 1, total: 1, invalidCount: 0 }) + "\n" + JSON.stringify({ type: "result", result: { platform: "douyin", status: "complete", received: 1, total: 1, invalidCount: 0 } }) + "\n" + JSON.stringify({ type: "done" }) + "\n";
        const bytes = encoder.encode(text);
        controller.enqueue(bytes.slice(0, 17));
        controller.enqueue(bytes.slice(17));
        controller.close();
      },
    });
    const events: string[] = [];
    await readFollowingStream(new Response(body), (event) => events.push(event.type), new AbortController().signal);
    expect(events).toEqual(["page", "result", "done"]);
  });
});
