"use client";

import { extractBvidFromPathname } from "@/lib/bilibili-id";
import { parsePublishedAt, sortVideos } from "@/lib/feed-logic";
import {
  getFeedVideoIdentityKey,
  isPlatformVideoUrl,
  MAX_FEED_DATE_LENGTH,
  MAX_FEED_DURATION_LENGTH,
  MAX_FEED_ID_LENGTH,
  MAX_FEED_NAME_LENGTH,
  MAX_FEED_SYNC_ERROR_LENGTH,
  MAX_FEED_TITLE_LENGTH,
  MAX_FEED_URL_LENGTH,
  normalizeFeedMediaUrl,
} from "@/lib/feed-storage";
import type { Creator, Platform, VideoItem } from "@/lib/feed-types";

export type SyncStatus = "idle" | "loading" | "success" | "partial" | "error";

export type SyncProgress = {
  status: SyncStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  currentStart: number;
  currentEnd: number;
  message: string;
  failedCreatorIds: string[];
  runId: number;
};

export type SyncResponse = {
  configured?: boolean;
  syncedAt?: string;
  videos?: Array<Partial<VideoItem>>;
  results?: Array<{
    creatorId?: string;
    status?: string;
    count?: number;
    complete?: boolean;
    mode?: "snapshot" | "incremental";
    message?: string;
    failureCode?: string;
    profile?: { name?: string; avatarUrl?: string };
  }>;
  error?: string;
};

export type SyncStateSnapshot = {
  creators: Creator[];
  videos: VideoItem[];
};

export type SyncMergeResult = SyncStateSnapshot & {
  failedCreatorIds: string[];
  incomingCount: number;
  succeededCount: number;
};

export const SYNC_BATCH_SIZE = 10;
export const DOUYIN_SYNC_BATCH_SIZE = 3;
export const DOUYIN_CIRCUIT_BREAKER_THRESHOLD = 3;
export const MAX_KNOWN_DOUYIN_VIDEO_IDS = 100;
export const SYNC_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
export const SYNC_RETRY_DELAY_MS = 1_200;
const DOUYIN_COOLDOWN_MIN_MS = 8_000;
const DOUYIN_COOLDOWN_RANGE_MS = 6_000;
const DOUYIN_RESTRICTION_CODES = new Set([
  "douyin_empty_response",
  "douyin_invalid_response",
  "douyin_rate_limited",
]);

export function buildSyncBatches(creators: Creator[]) {
  const batches: Creator[][] = [];
  for (let start = 0; start < creators.length;) {
    const platform = creators[start].platform;
    const limit = platform === "douyin" ? DOUYIN_SYNC_BATCH_SIZE : SYNC_BATCH_SIZE;
    const batch: Creator[] = [];
    while (
      start < creators.length
      && batch.length < limit
      && creators[start].platform === platform
    ) {
      batch.push(creators[start]);
      start += 1;
    }
    batches.push(batch);
  }
  return batches;
}

export function getDouyinCooldownMs(random = Math.random) {
  return DOUYIN_COOLDOWN_MIN_MS + Math.floor(random() * (DOUYIN_COOLDOWN_RANGE_MS + 1));
}

export function isDouyinRestrictionFailure(result: NonNullable<SyncResponse["results"]>[number]) {
  return result.status === "error"
    && typeof result.failureCode === "string"
    && DOUYIN_RESTRICTION_CODES.has(result.failureCode);
}

export function collectKnownDouyinVideoIds(videos: VideoItem[], creatorId: string) {
  const ids = new Set<string>();
  for (const video of sortVideos(videos.filter((item) => (
    item.creatorId === creatorId
    && item.platform === "douyin"
    && item.source === "feed-sync"
  )))) {
    try {
      const id = new URL(video.videoUrl).pathname.match(/^\/video\/(\d+)(?:\/|$)/)?.[1];
      if (id) ids.add(id);
    } catch {
      // Invalid stored URLs are filtered elsewhere and cannot become an anchor.
    }
    if (ids.size >= MAX_KNOWN_DOUYIN_VIDEO_IDS) break;
  }
  return Array.from(ids);
}

export function getKnownDouyinVideoIdsForSync(creator: Creator, videos: VideoItem[]) {
  return creator.platform === "douyin" && !creator.syncError
    ? collectKnownDouyinVideoIds(videos, creator.id)
    : [];
}

function isAbortError(error: unknown) {
  return (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

function createAbortError() {
  return typeof DOMException !== "undefined"
    ? new DOMException("同步已取消", "AbortError")
    : Object.assign(new Error("同步已取消"), { name: "AbortError" });
}

/** Raised when one request consumed the whole server-side budget without answering. */
class SyncRequestTimeoutError extends Error {
  constructor() {
    super("同步服务响应超时");
    this.name = "SyncRequestTimeoutError";
  }
}

/** Carries the HTTP status so retry decisions do not depend on message wording. */
class SyncHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SyncHttpError";
  }
}

export function waitWithSignal(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function syncRequestError(error: unknown) {
  if (isAbortError(error)) return "同步请求已取消；已有缓存已保留";
  if (error instanceof TypeError) return "网站服务不可用，请先运行 npm run start:local";
  return error instanceof Error ? error.message : "同步请求失败";
}

function isRetryableSyncRequestError(error: unknown) {
  if (isAbortError(error) || error instanceof SyncRequestTimeoutError) return false;
  if (error instanceof SyncHttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  if (error instanceof TypeError) return true;
  return error instanceof Error && /HTTP (408|429|5\d\d)|返回异常|超时/.test(error.message);
}

async function requestSyncBatchOnce(
  batch: Creator[],
  signal: AbortSignal,
  existingVideos: VideoItem[],
) {
  if (signal.aborted) throw createAbortError();

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SYNC_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("/api/feed/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creators: batch.map((creator) => ({
          id: creator.id,
          platform: creator.platform,
          profileUrl: creator.profileUrl,
          name: creator.name,
          ...(creator.platform === "douyin"
            ? { knownVideoIds: getKnownDouyinVideoIdsForSync(creator, existingVideos) }
            : {}),
        })),
      }),
      signal: controller.signal,
    });

    let data: SyncResponse;
    try {
      data = await response.json() as SyncResponse;
    } catch {
      throw new Error(`同步服务返回异常（HTTP ${response.status}）`);
    }
    if (!response.ok && !Array.isArray(data.results)) {
      throw new SyncHttpError(data.error || `同步服务返回 HTTP ${response.status}`, response.status);
    }
    return data;
  } catch (error) {
    if (signal.aborted) throw createAbortError();
    if (timedOut || (isAbortError(error) && !signal.aborted)) {
      throw new SyncRequestTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

export async function requestSyncBatch(
  batch: Creator[],
  signal: AbortSignal,
  existingVideos: VideoItem[] = [],
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await requestSyncBatchOnce(batch, signal, existingVideos);
    } catch (error) {
      lastError = error;
      if (signal.aborted) throw createAbortError();
      if (attempt === 0 && isRetryableSyncRequestError(error)) {
        await waitWithSignal(SYNC_RETRY_DELAY_MS, signal);
        continue;
      }
      throw new Error(syncRequestError(lastError));
    }
  }
  throw new Error(syncRequestError(lastError));
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function boundedString(value: unknown, maximum: number) {
  const text = asNonEmptyString(value);
  return text.length <= maximum ? text : "";
}

function truncatedString(value: unknown, maximum: number) {
  return asNonEmptyString(value).slice(0, maximum);
}

function validDateString(value: unknown) {
  const text = boundedString(value, MAX_FEED_DATE_LENGTH);
  return text && parsePublishedAt(text) ? text : "";
}

function platformLabel(platform: Platform) {
  return platform === "douyin" ? "抖音" : "哔站";
}

function isFallbackCreator(creator: Creator) {
  return creator.nameSource === "fallback" || creator.name === `${platformLabel(creator.platform)}博主`;
}

function canonicalSyncVideoId(platform: Platform, videoUrl: string, fallbackId: string) {
  try {
    const pathname = new URL(videoUrl).pathname;
    const platformId = platform === "bilibili"
      ? extractBvidFromPathname(pathname)
      : pathname.match(/^\/video\/(\d+)(?:\/|$)/)?.[1];
    return platformId ? `sync-${platform}-${platformId}` : fallbackId;
  } catch {
    return fallbackId;
  }
}

function toIncomingVideos(data: SyncResponse, batch: Creator[], syncedAt: string) {
  const batchById = new Map(batch.map((creator) => [creator.id, creator]));
  return (data.videos ?? []).flatMap((item): VideoItem[] => {
    const id = boundedString(item.id, MAX_FEED_ID_LENGTH);
    const videoUrl = boundedString(item.videoUrl, MAX_FEED_URL_LENGTH);
    const creatorId = boundedString(item.creatorId, MAX_FEED_ID_LENGTH);
    const title = truncatedString(item.title, MAX_FEED_TITLE_LENGTH);
    const creator = batchById.get(creatorId);
    if (
      !id
      || (item.platform !== "douyin" && item.platform !== "bilibili")
      || !videoUrl
      || !isPlatformVideoUrl(videoUrl, item.platform)
      || !creator
      || creator.platform !== item.platform
      || !title
    ) return [];
    const coverUrl = normalizeFeedMediaUrl(item.coverUrl);
    const publishedAt = validDateString(item.publishedAt);
    const duration = truncatedString(item.duration, MAX_FEED_DURATION_LENGTH);
    const createdAt = validDateString(item.createdAt) || syncedAt;
    return [{
      id: canonicalSyncVideoId(item.platform, videoUrl, id),
      platform: item.platform,
      videoUrl: new URL(videoUrl).toString(),
      creatorId,
      title,
      ...(coverUrl ? { coverUrl } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(duration ? { duration } : {}),
      source: "feed-sync",
      createdAt,
    }];
  });
}

export function mergeSyncResponse(
  state: SyncStateSnapshot,
  batch: Creator[],
  data: SyncResponse,
): SyncMergeResult {
  const reportedResults = Array.isArray(data.results) ? data.results : [];
  const reportedMap = new Map(reportedResults.map((item) => [item.creatorId, item]));
  const results = batch.map((creator) => reportedMap.get(creator.id) ?? {
    creatorId: creator.id,
    status: "error",
    count: 0,
    mode: "snapshot" as const,
    message: "同步服务未返回该博主结果",
  });
  const syncedAt = validDateString(data.syncedAt) || new Date().toISOString();
  const candidateVideos = toIncomingVideos(data, batch, syncedAt);
  const incomingByCreator = new Map<string, VideoItem[]>();
  candidateVideos.forEach((video) => {
    const current = incomingByCreator.get(video.creatorId) ?? [];
    current.push(video);
    incomingByCreator.set(video.creatorId, current);
  });
  const completeIds = new Set(results.flatMap((result) => {
    if (typeof result.creatorId !== "string") return [];
    const creatorVideos = incomingByCreator.get(result.creatorId) ?? [];
    const uniqueIds = new Set(creatorVideos.map((video) => video.id));
    const uniqueUrls = new Set(creatorVideos.map((video) => getFeedVideoIdentityKey(video.videoUrl, video.platform)));
    const countMatches = Number.isSafeInteger(result.count)
      && result.count === creatorVideos.length
      && uniqueIds.size === creatorVideos.length
      && uniqueUrls.size === creatorVideos.length;
    return result.status === "success" && result.complete === true && countMatches
      ? [result.creatorId]
      : [];
  }));
  const incoming = candidateVideos.filter((video) => completeIds.has(video.creatorId));
  const snapshotIds = new Set(results.flatMap((result) => (
    typeof result.creatorId === "string"
      && completeIds.has(result.creatorId)
      && result.mode !== "incremental"
      ? [result.creatorId]
      : []
  )));
  const failedCreatorIds = results
    .filter((result) => typeof result.creatorId === "string" && !completeIds.has(result.creatorId))
    .map((result) => result.creatorId as string);

  const retained = state.videos.filter((video) => !snapshotIds.has(video.creatorId) || video.source !== "feed-sync");
  const byIdentity = new Map(retained.map((video) => [
    getFeedVideoIdentityKey(video.videoUrl, video.platform),
    video,
  ]));
  incoming.forEach((video) => {
    const identityKey = getFeedVideoIdentityKey(video.videoUrl, video.platform);
    const existing = byIdentity.get(identityKey);
    if (!existing) {
      byIdentity.set(identityKey, video);
      return;
    }
    if (existing.source === "manual" || existing.source === "public-metadata") {
      byIdentity.set(identityKey, {
        ...existing,
        coverUrl: existing.coverUrl || video.coverUrl,
        publishedAt: existing.publishedAt || video.publishedAt,
        duration: existing.duration || video.duration,
      });
    } else {
      byIdentity.set(identityKey, video);
    }
  });

  const resultMap = new Map(results.map((result) => [result.creatorId, result]));
  const creators = state.creators.map((creator) => {
    const result = resultMap.get(creator.id);
    if (!result) return creator;
    if (!completeIds.has(creator.id)) {
      return {
        ...creator,
        syncError: truncatedString(result.message, MAX_FEED_SYNC_ERROR_LENGTH)
          || (result.status === "success" ? "同步结果不完整，已保留旧缓存" : "同步失败"),
      };
    }
    const profile = result.profile;
    const profileName = truncatedString(profile?.name, MAX_FEED_NAME_LENGTH);
    const avatarUrl = normalizeFeedMediaUrl(profile?.avatarUrl);
    const canRename = isFallbackCreator(creator) && Boolean(profileName);
    return {
      ...creator,
      ...(canRename ? { name: profileName, nameSource: "platform" as const } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      lastSyncAt: syncedAt,
      syncError: undefined,
    };
  });

  return {
    creators,
    videos: Array.from(byIdentity.values()),
    failedCreatorIds,
    incomingCount: incoming.length,
    succeededCount: completeIds.size,
  };
}

export function markBatchFailed(
  state: SyncStateSnapshot,
  batch: Creator[],
  message: string,
): SyncStateSnapshot {
  const ids = new Set(batch.map((creator) => creator.id));
  const safeMessage = truncatedString(message, MAX_FEED_SYNC_ERROR_LENGTH) || "同步失败";
  return {
    creators: state.creators.map((creator) => ids.has(creator.id) ? { ...creator, syncError: safeMessage } : creator),
    videos: state.videos,
  };
}
