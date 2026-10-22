import { parsePublishedAt } from "@/lib/feed-logic";
import {
  getFeedCreatorIdentityKey,
  getFeedVideoIdentityKey,
  isPlatformProfileUrl,
  MAX_FEED_CREATORS,
  normalizeFeedMediaUrl,
} from "@/lib/feed-storage";
import type { Creator, Platform, VideoItem } from "@/lib/feed-types";

export type CreatorDraft = {
  platform: Platform;
  profileUrl: string;
  name: string;
  nameSource: "manual" | "fallback" | "platform";
  avatarUrl?: string;
};

export const MAX_CREATOR_IMPORT_LINES = MAX_FEED_CREATORS;

const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });
const LONG_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" });
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const COUNT_FORMATTER = new Intl.NumberFormat("zh-CN");

export function platformLabel(platform: Platform) {
  return platform === "douyin" ? "抖音" : "哔站";
}

export function platformClass(platform: Platform) {
  return platform === "douyin" ? "platform-douyin" : "platform-bilibili";
}

export function detectPlatform(value: string): Platform | null {
  try {
    const host = new URL(value.trim()).hostname.toLowerCase();
    if (["douyin.com", "iesdouyin.com"].some((item) => host === item || host.endsWith(`.${item}`))) return "douyin";
    if (["bilibili.com", "b23.tv"].some((item) => host === item || host.endsWith(`.${item}`))) return "bilibili";
    return null;
  } catch {
    return null;
  }
}

export function normalizeUrl(value: string) {
  const cleaned = value.trim().replace(/^["'<>\s]+|["'<>，,；;。\s]+$/g, "");
  try {
    return new URL(cleaned).toString();
  } catch {
    return cleaned;
  }
}

export function normalizeOptionalMediaUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return normalizeFeedMediaUrl(trimmed) ?? null;
}

/**
 * Share buttons on both platforms produce short links (b23.tv / v.douyin.com) that
 * identify a video but are not storable detail URLs. They must be resolved through
 * the metadata route before the video can be saved.
 */
export function isResolvableShortVideoLink(value: string) {
  try {
    const url = new URL(normalizeUrl(value));
    const host = url.hostname.toLowerCase();
    const isShortHost = host === "b23.tv"
      || host.endsWith(".b23.tv")
      || host === "v.douyin.com";
    return isShortHost && /^\/[0-9A-Za-z_-]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function appendUniqueCreators(
  current: Creator[],
  items: CreatorDraft[],
  createId: () => string,
) {
  const known = new Set(current.map((creator) => getFeedCreatorIdentityKey(creator.profileUrl, creator.platform)));
  const additions = items.flatMap((item) => {
    const key = getFeedCreatorIdentityKey(item.profileUrl, item.platform);
    if (known.has(key)) return [];
    known.add(key);
    return [{ ...item, id: createId(), enabled: true }];
  });
  return {
    next: additions.length ? [...current, ...additions] : current,
    added: additions.length,
  };
}

export function appendUniqueVideo(current: VideoItem[], video: VideoItem) {
  const key = getFeedVideoIdentityKey(video.videoUrl, video.platform);
  if (current.some((entry) => getFeedVideoIdentityKey(entry.videoUrl, entry.platform) === key)) {
    return { next: current, added: false };
  }
  return { next: [...current, video], added: true };
}

export function sameEntityIds<T extends { id: string }>(items: T[], expected: ReadonlySet<string>) {
  const actual = new Set(items.map((item) => item.id));
  return actual.size === expected.size && items.length === actual.size && [...actual].every((id) => expected.has(id));
}

export function formatDate(value?: string) {
  const date = parsePublishedAt(value);
  return !date ? "发布时间未知" : SHORT_DATE_FORMATTER.format(date);
}

export function formatLongDate(value?: string) {
  const date = parsePublishedAt(value);
  return !date ? "暂无记录" : LONG_DATE_FORMATTER.format(date);
}

export function formatDateTime(value?: string) {
  const date = parsePublishedAt(value);
  return !date ? "待同步" : DATE_TIME_FORMATTER.format(date);
}

export function formatCount(value: number) {
  return COUNT_FORMATTER.format(value);
}

export function parseCreatorLines(value: string) {
  const entries: CreatorDraft[] = [];
  const invalidLines: number[] = [];
  const duplicateLines: number[] = [];
  const seen = new Set<string>();
  const lines = value.split(/\r?\n/);
  // Blank lines and a trailing newline must not count against the import limit.
  const meaningfulLines = lines
    .map((text, index) => ({ text, lineNumber: index + 1 }))
    .filter((item) => item.text.trim());
  const limitExceeded = meaningfulLines.length > MAX_CREATOR_IMPORT_LINES;

  meaningfulLines.slice(0, MAX_CREATOR_IMPORT_LINES).forEach(({ text: rawLine, lineNumber }) => {
    const line = rawLine.trim();
    if (/^(url|link|链接|主页|名称|昵称)\s*[:：,，;；\t]?\s*(?:https?:\/\/|$)/i.test(line)) return;

    const match = line.match(/https?:\/\/[^\s，,；;\t]+/i);
    if (!match || match.index === undefined) {
      invalidLines.push(lineNumber);
      return;
    }
    const profileUrl = normalizeUrl(match[0]);
    const platform = detectPlatform(profileUrl);
    if (!platform || !isPlatformProfileUrl(profileUrl, platform)) {
      invalidLines.push(lineNumber);
      return;
    }

    const before = line.slice(0, match.index).replace(/["'\s|｜:：]+/g, " ").trim();
    const after = line.slice(match.index + match[0].length).replace(/["'\s|｜:：]+/g, " ").trim();
    const name = (before || after).replace(/^[,，;；\t]+|[,，;；\t]+$/g, "").trim().slice(0, 80);
    const key = getFeedCreatorIdentityKey(profileUrl, platform);
    if (seen.has(key)) {
      duplicateLines.push(lineNumber);
      return;
    }
    seen.add(key);
    entries.push({
      platform,
      profileUrl,
      name: name || `${platformLabel(platform)}博主`,
      nameSource: name ? "manual" : "fallback",
    });
  });

  return { entries, invalidLines, duplicateLines, limitExceeded };
}
