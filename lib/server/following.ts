import "server-only";

import type { FollowingCreator } from "@/lib/following-list";
import { collectBilibiliFollowing, type BilibiliFollowingPage } from "@/lib/bilibili-browser";
import { collectDouyinFollowing, type DouyinFollowingPage } from "@/lib/douyin-browser";

export type FollowingCallbacks = {
  account: (platform: "douyin" | "bilibili", account: { id: string; name: string }) => void;
  page: (platform: "douyin" | "bilibili", creators: FollowingCreator[], received: number, total: number, invalidCount: number) => void;
};

export async function collectDouyin(callbacks: FollowingCallbacks, signal?: AbortSignal) {
  let accountSent = false;
  const result = await collectDouyinFollowing(async (page: DouyinFollowingPage) => {
    if (!accountSent) { callbacks.account("douyin", page.account ?? { id: "self", name: "当前抖音账号" }); accountSent = true; }
    if (page.creators.length || page.received === 0) callbacks.page("douyin", page.creators, page.received, page.total, page.invalidCount);
  }, signal);
  return { received: result.received, total: result.total, invalidCount: result.invalidCount };
}

export async function collectBilibili(callbacks: FollowingCallbacks, signal?: AbortSignal) {
  let accountSent = false;
  const result = await collectBilibiliFollowing(async (page: BilibiliFollowingPage) => {
    if (!accountSent) {
      callbacks.account("bilibili", page.account ?? { id: "self", name: "当前哔站账号" });
      accountSent = true;
    }
    callbacks.page("bilibili", page.creators, page.received, page.total, page.invalidCount);
  }, signal);
  return { received: result.received, total: result.total, invalidCount: result.invalidCount };
}
