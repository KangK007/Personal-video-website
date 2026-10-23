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
  skipped: number;
  /** Creators intentionally left for a later run by the per-run platform limit. */
  deferred: number;
  restrictedPlatforms: Platform[];
  currentStart: number;
  currentEnd: number;
  message: string;
  failedCreatorIds: string[];
  skippedCreatorIds: string[];
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
  /** Complete-but-empty results that kept their cache (first confirmation or bulk suspicion). */
  emptySnapshotCreatorIds: string[];
  /** Several creators in the same batch all returned "complete but empty": likely rate limiting. */
  suspiciousEmptySnapshot: boolean;
  incomingCount: number;
  succeededCount: number;
};

export const SYNC_BATCH_SIZE = 1;
export const DOUYIN_SYNC_BATCH_SIZE = 3;
export const DOUYIN_CIRCUIT_BREAKER_THRESHOLD = 3;
/** Consecutive request/provider failures after which the remaining run is stopped. */
export const MAX_CONSECUTIVE_PROVIDER_FAILURES = 3;
export const MAX_KNOWN_DOUYIN_VIDEO_IDS = 100;
export const SYNC_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
export const SYNC_RETRY_DELAY_MS = 1_200;
/** How long to wait before retrying a batch after a platform rate-limit answer. */
export const RESTRICTION_RETRY_DELAY_MS = 20_000;
/** Bilibili is paced much slower, so one run only covers a slice of the list. */
export const MAX_BILIBILI_CREATORS_PER_RUN = 50;
/** Maximum number of chained slices one clicked sync may run automatically. */
export const MAX_AUTO_SYNC_ROUNDS = 10;
/** Breather between automatically continued slices. */
export const AUTO_SYNC_CONTINUE_DELAY_MS = 15_000;

/**
 * Decides whether a clean slice should be followed by another slice automatically.
 * Any failure, empty-result signal or platform restriction stops the chain so a bad
 * platform day cannot turn into a long unattended loop.
 */
export function shouldAutoContinueSync(input: {
  round: number;
  maxRounds: number;
  deferred: number;
  failed: number;
  emptySkipped: number;
  bilibiliBlocked: boolean;
  restricted: number;
  aborted: boolean;
  runValid: boolean;
}): boolean {
  return input.runValid
    && !input.aborted
    && input.round < input.maxRounds
    && input.deferred > 0
    && input.failed === 0
    && input.emptySkipped === 0
    && !input.bilibiliBlocked
    && input.restricted === 0;
}
const DOUYIN_COOLDOWN_MIN_MS = 8_000;
const DOUYIN_COOLDOWN_RANGE_MS = 6_000;
const BILIBILI_COOLDOWN_MIN_MS = 3_000;
const BILIBILI_COOLDOWN_RANGE_MS = 2_000;
const DOUYIN_RESTRICTION_CODES = new Set([
  "douyin_empty_response",
  "douyin_invalid_response",
  "douyin_rate_limited",
  "douyin_circuit_open",
]);
const BILIBILI_RESTRICTION_CODES = new Set(["bilibili_rate_limited", "bilibili_circuit_open"]);

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

export function getBilibiliCooldownMs(random = Math.random) {
  return BILIBILI_COOLDOWN_MIN_MS + Math.floor(random() * (BILIBILI_COOLDOWN_RANGE_MS + 1));
}

/**
 * Orders Bilibili creators so a limited run makes progress: failures first, then
 * never-synced records, then the oldest successful syncs.
 */
export function prioritizeBilibiliCreators(creators: Creator[]) {
  const priority = (creator: Creator) => (creator.syncError ? 0 : creator.lastSyncAt ? 2 : 1);
  const syncedAt = (creator: Creator) => {
    const value = creator.lastSyncAt ? Date.parse(creator.lastSyncAt) : Number.NaN;
    return Number.isNaN(value) ? 0 : value;
  };
  return [...creators].sort((a, b) => {
    const diff = priority(a) - priority(b);
    if (diff !== 0) return diff;
    return syncedAt(a) - syncedAt(b);
  });
}

/**
 * Caps how many Bilibili creators one run requests, leaving the rest untouched for
 * later runs. Non-Bilibili creators keep their original position.
 */
export function applyBilibiliRunLimit(targets: Creator[]): { planned: Creator[]; deferred: Creator[] } {
  const bilibili = targets.filter((creator) => creator.platform === "bilibili");
  if (bilibili.length <= MAX_BILIBILI_CREATORS_PER_RUN) {
    return { planned: targets, deferred: [] };
  }
  const keep = new Set(
    prioritizeBilibiliCreators(bilibili)
      .slice(0, MAX_BILIBILI_CREATORS_PER_RUN)
      .map((creator) => creator.id),
  );
  const planned: Creator[] = [];
  const deferred: Creator[] = [];
  for (const creator of targets) {
    if (creator.platform !== "bilibili" || keep.has(creator.id)) planned.push(creator);
    else deferred.push(creator);
  }
  return { planned, deferred };
}

export function isDouyinRestrictionFailure(result: NonNullable<SyncResponse["results"]>[number]) {
  return result.status === "error"
    && typeof result.failureCode === "string"
    && DOUYIN_RESTRICTION_CODES.has(result.failureCode);
}

export function getRestrictedSyncPlatform(batch: Creator[], data: SyncResponse): Platform | null {
  for (const result of data.results ?? []) {
    if (result.status !== "error" || typeof result.failureCode !== "string") continue;
    const creator = batch.find((item) => item.id === result.creatorId);
    if (creator?.platform === "douyin" && DOUYIN_RESTRICTION_CODES.has(result.failureCode)) return "douyin";
    if (creator?.platform === "bilibili" && BILIBILI_RESTRICTION_CODES.has(result.failureCode)) return "bilibili";
  }
  return null;
}

/** True when every creator in the answered batch failed because the provider itself was down. */
export function isProviderUnavailableFailure(data: SyncResponse): boolean {
  const results = data.results ?? [];
  return results.length > 0
    && results.every((result) => result.status === "error" && result.failureCode === "provider_unavailable");
}

/**
 * Clears stale per-creator sync errors for records a run no longer reports as failed.
 * Without this, a creator that is skipped because its platform is rate limited keeps
 * its previous error forever and the error count can never recover.
 */
export function clearSyncErrors(state: SyncStateSnapshot, ids: Iterable<string>): SyncStateSnapshot {
  const targets = new Set(ids);
  if (!state.creators.some((creator) => creator.syncError && targets.has(creator.id))) {
    return state;
  }
  return {
    creators: state.creators.map((creator) => (
      targets.has(creator.id) && creator.syncError
        ? { ...creator, syncError: undefined }
        : creator
    )),
    videos: state.videos,
  };
}

/**
 * Summarizes the outcome of one sync run. "partial" means something was synced but
 * not everything; when nothing was synced the top bar must not claim success.
 */
export function computeSyncStatus(input: {
  failed: number;
  succeeded: number;
  skipped: number;
  deferred: number;
}): SyncStatus {
  const { failed, succeeded, skipped, deferred } = input;
  if (failed > 0) return succeeded > 0 ? "partial" : "error";
  // Skipped/empty/blocked results are incomplete work, never a platform failure.
  if (skipped > 0 || deferred > 0) return "partial";
  return "success";
}

/**
 * Merges the retry of a rate-limited batch into its first answer. Creators that
 * already succeeded must keep their first result (and videos); only the rest is
 * taken from the retry, mirroring the provider-unavailable retry in
 * requestSyncBatch.
 */
export function mergeRestrictionRetry(original: SyncResponse, retried: SyncResponse): SyncResponse {
  const originalResults = original.results ?? [];
  const retriedResults = retried.results ?? [];
  const kept = new Set(originalResults.flatMap((result) => (
    result.status === "success" && typeof result.creatorId === "string" ? [result.creatorId] : []
  )));
  const retriedMap = new Map(retriedResults.map((result) => [result.creatorId, result]));
  const mergedResults = originalResults.map((result) => (
    kept.has(result.creatorId ?? "") ? result : retriedMap.get(result.creatorId ?? "") ?? result
  ));
  const knownIds = new Set(mergedResults.map((result) => result.creatorId));
  for (const result of retriedResults) {
    if (!knownIds.has(result.creatorId)) mergedResults.push(result);
  }
  return {
    ...original,
    configured: original.configured ?? retried.configured,
    syncedAt: original.syncedAt ?? retried.syncedAt,
    videos: [
      ...(original.videos ?? []).filter((video) => kept.has(video.creatorId ?? "")),
      ...(retried.videos ?? []).filter((video) => !kept.has(video.creatorId ?? "")),
    ],
    results: mergedResults,
  };
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
  if (error instanceof SyncHttpError) {
    // 504 is our own server-side deadline; retrying immediately would just hang again.
    return error.status !== 504 && (error.status === 408 || error.status === 429 || error.status >= 500);
  }
  if (error instanceof TypeError) return true;
  return error instanceof Error && /HTTP (408|429|5\d\d)|返回异常|超时/.test(error.message);
}

function getRetryableProviderCreators(batch: Creator[], data: SyncResponse) {
  const results = new Map((data.results ?? []).map((result) => [result.creatorId, result]));
  return batch.filter((creator) => {
    const result = results.get(creator.id);
    return result?.status === "error" && result.failureCode === "provider_unavailable";
  });
}

function mergeProviderRetry(
  original: SyncResponse,
  retried: SyncResponse,
  retriedCreators: Creator[],
): SyncResponse {
  const retriedIds = new Set(retriedCreators.map((creator) => creator.id));
  const retriedResults = new Map((retried.results ?? []).map((result) => [result.creatorId, result]));
  return {
    ...original,
    configured: original.configured ?? retried.configured,
    syncedAt: original.syncedAt ?? retried.syncedAt,
    videos: [
      ...(original.videos ?? []).filter((video) => !retriedIds.has(video.creatorId ?? "")),
      ...(retried.videos ?? []),
    ],
    results: (original.results ?? []).map((result) => (
      retriedIds.has(result.creatorId ?? "")
        ? retriedResults.get(result.creatorId) ?? result
        : result
    )),
  };
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
    if (!response.ok && (!Array.isArray(data.results) || data.results.length === 0)) {
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
  let data: SyncResponse | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      data = await requestSyncBatchOnce(batch, signal, existingVideos);
      break;
    } catch (error) {
      lastError = error;
      if (signal.aborted) throw createAbortError();
      if (attempt === 0 && isRetryableSyncRequestError(error)) {
        await waitWithSignal(SYNC_RETRY_DELAY_MS, signal);
        continue;
      }
      throw withProviderFailureFlag(new Error(syncRequestError(lastError)), lastError);
    }
  }
  if (!data) throw withProviderFailureFlag(new Error(syncRequestError(lastError)), lastError);

  const retryableCreators = getRetryableProviderCreators(batch, data);
  if (!retryableCreators.length) return data;
  await waitWithSignal(SYNC_RETRY_DELAY_MS, signal);
  try {
    const retried = await requestSyncBatchOnce(retryableCreators, signal, existingVideos);
    return mergeProviderRetry(data, retried, retryableCreators);
  } catch {
    if (signal.aborted) throw createAbortError();
    return data;
  }
}

/**
 * Narrows a sync batch to creators that still exist locally with the same platform.
 * Records changed by the user during a run are reported as removed instead of
 * aborting the whole run, so the remaining batches can still make progress.
 */
export function reconcileSyncBatch(batch: Creator[], currentCreators: Creator[]) {
  const live = new Map(currentCreators.map((creator) => [creator.id, creator]));
  const active: Creator[] = [];
  const removed: Creator[] = [];
  for (const creator of batch) {
    const current = live.get(creator.id);
    if (current && current.platform === creator.platform) active.push(current);
    else removed.push(creator);
  }
  return { active, removed };
}

/**
 * True when an error means the sync provider is unreachable/unstable (network,
 * timeout, 5xx/408/429). Local configuration or contract errors are not provider
 * failures and must not trip the provider circuit breaker.
 */
export function isProviderFailureError(error: unknown): boolean {
  if (error instanceof SyncRequestTimeoutError) return true;
  if (error instanceof SyncHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof TypeError) return true;
  return Boolean((error as { providerFailure?: unknown } | null)?.providerFailure);
}

/** Tags a wrapped error with the provider-failure classification it was built from. */
function withProviderFailureFlag(error: Error, source: unknown) {
  Object.defineProperty(error, "providerFailure", {
    value: isProviderFailureError(source),
    enumerable: false,
  });
  if (source instanceof SyncHttpError) {
    Object.defineProperty(error, "httpStatus", {
      value: source.status,
      enumerable: false,
    });
  }
  return error;
}

/**
 * True when the sync route refused the batch because another sync is still running.
 * This is a temporary local condition, not a platform failure: the run should stop
 * gracefully instead of labeling the whole batch as failed.
 */
export function isSyncBusyError(error: unknown): boolean {
  return (error as { httpStatus?: unknown } | null)?.httpStatus === 409;
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
  // A "complete" empty snapshot can also be a disguised failure (risk control or an
  // API shape change). Do not wipe a creator's cached videos on the first empty
  // answer; require one more consecutive empty snapshot to confirm it.
  const creatorsById = new Map(state.creators.map((creator) => [creator.id, creator]));
  const cachedCreatorIds = new Set(
    state.videos.filter((video) => video.source === "feed-sync").map((video) => video.creatorId),
  );
  const emptyCompleteIds = [...completeIds].filter((creatorId) => (incomingByCreator.get(creatorId) ?? []).length === 0);
  // Batches of several creators that all answer "complete but empty" are almost always
  // platform rate limiting, not accounts that deleted everything. Never treat them as
  // confirmation (otherwise two bad runs would erase all caches), and report them as
  // skipped so the client stops the platform for this run instead of counting failures.
  const suspiciousEmptySnapshot = batch.length >= 2
    && emptyCompleteIds.length >= 2
    && emptyCompleteIds.length === completeIds.size;
  const emptySnapshotCreatorIds: string[] = [];
  const emptySnapshotIncrements = new Set<string>();
  for (const creatorId of emptyCompleteIds) {
    const creator = creatorsById.get(creatorId);
    if (!creator) continue;
    if (suspiciousEmptySnapshot) {
      completeIds.delete(creatorId);
      emptySnapshotCreatorIds.push(creatorId);
      continue;
    }
    if (!cachedCreatorIds.has(creatorId)) continue;
    if ((creator.emptySnapshotCount ?? 0) < 1) {
      completeIds.delete(creatorId);
      emptySnapshotCreatorIds.push(creatorId);
      emptySnapshotIncrements.add(creatorId);
    }
  }
  const emptySnapshotSet = new Set(emptySnapshotCreatorIds);
  const incoming = candidateVideos.filter((video) => completeIds.has(video.creatorId));
  const snapshotIds = new Set(results.flatMap((result) => (
    typeof result.creatorId === "string"
      && completeIds.has(result.creatorId)
      && result.mode !== "incremental"
      ? [result.creatorId]
      : []
  )));
  const failedCreatorIds = results
    .filter((result) => typeof result.creatorId === "string"
      && !completeIds.has(result.creatorId)
      && !emptySnapshotSet.has(result.creatorId))
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
    if (emptySnapshotSet.has(creator.id)) {
      // Skipped, not failed: the cache is kept and the progress message explains it.
      return emptySnapshotIncrements.has(creator.id)
        ? { ...creator, emptySnapshotCount: Math.min((creator.emptySnapshotCount ?? 0) + 1, 10) }
        : creator;
    }
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
      // A confirmed (second consecutive) or non-empty snapshot resets the guard.
      emptySnapshotCount: undefined,
    };
  });

  return {
    creators,
    videos: Array.from(byIdentity.values()),
    failedCreatorIds,
    emptySnapshotCreatorIds,
    suspiciousEmptySnapshot,
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
