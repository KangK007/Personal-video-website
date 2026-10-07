"use client";

import type { Creator, FeedState, VideoItem } from "@/lib/feed-types";

const DATABASE_NAME = "just-follow-feed";
const DATABASE_VERSION = 2;
const STORE_NAME = "state";
const FEED_KEY = "feed";

export const MAX_BACKUP_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_FEED_CREATORS = 10_000;
export const MAX_FEED_VIDEOS = 150_000;

export const MAX_FEED_ID_LENGTH = 256;
export const MAX_FEED_URL_LENGTH = 2_048;
export const MAX_FEED_NAME_LENGTH = 80;
export const MAX_FEED_TITLE_LENGTH = 300;
export const MAX_FEED_DATE_LENGTH = 64;
export const MAX_FEED_DURATION_LENGTH = 64;
export const MAX_FEED_SYNC_ERROR_LENGTH = 500;

export type StoredFeedState = FeedState & {
  revision: number;
  recoveryMessage?: string;
  needsRewrite?: boolean;
};

export class FeedStorageConflictError extends Error {
  constructor(public readonly actualRevision: number) {
    super("本地数据已在另一个标签页更新");
    this.name = "FeedStorageConflictError";
  }
}

const VALID_SOURCES = new Set(["public-metadata", "manual", "sample", "feed-sync"]);
const PLATFORM_HOSTS = {
  douyin: ["douyin.com", "iesdouyin.com"],
  bilibili: ["bilibili.com", "b23.tv"],
} satisfies Record<Creator["platform"], string[]>;

function asOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoundedString(value: unknown, maximum: number) {
  const text = asOptionalString(value);
  return text && text.length <= maximum ? text : undefined;
}

function normalizeHttpUrl(value: unknown, platform?: Creator["platform"]) {
  const raw = asOptionalString(value);
  if (!raw || raw.length > MAX_FEED_URL_LENGTH) return undefined;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    if (platform && !PLATFORM_HOSTS[platform].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function fallbackIdentityKey(value: unknown, platform: Creator["platform"]) {
  const raw = asOptionalString(value) ?? "";
  try {
    const url = new URL(raw);
    return `${platform}:url:${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return `${platform}:url:${raw.toLowerCase()}`;
  }
}

export function getFeedCreatorIdentityKey(value: unknown, platform: Creator["platform"]) {
  const normalized = normalizeHttpUrl(value, platform);
  if (!normalized) return fallbackIdentityKey(value, platform);
  const url = new URL(normalized);
  const id = platform === "bilibili"
    ? url.pathname.match(/^\/(?:space\/)?(\d+)(?:\/|$)/i)?.[1]
    : url.pathname.match(/^\/user\/([^/]+)\/?$/i)?.[1];
  return id ? `${platform}:creator:${id}` : fallbackIdentityKey(normalized, platform);
}

function getBilibiliPageNumber(url: URL) {
  const value = url.searchParams.get("p");
  if (!value || !/^\d+$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function getPlatformVideoIdentity(value: unknown, platform: VideoItem["platform"]) {
  const normalized = normalizeHttpUrl(value, platform);
  if (!normalized) return null;
  const url = new URL(normalized);
  const id = platform === "bilibili"
    ? url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{8,20})(?:\/|$)/i)?.[1]
    : url.pathname.match(/^\/video\/(\d{10,})(?:\/|$)/)?.[1];
  return id ? { id, page: platform === "bilibili" ? getBilibiliPageNumber(url) : 1 } : null;
}

export function getFeedVideoIdentityKey(value: unknown, platform: VideoItem["platform"]) {
  const identity = getPlatformVideoIdentity(value, platform);
  if (identity) return `${platform}:video:${identity.id}${platform === "bilibili" ? `:p${identity.page}` : ""}`;
  return fallbackIdentityKey(value, platform);
}

function migrateCreator(value: unknown, version: number): Creator | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Creator>;
  const id = asBoundedString(item.id, MAX_FEED_ID_LENGTH);
  if (!id) return null;
  if (item.platform !== "douyin" && item.platform !== "bilibili") return null;
  const profileUrl = normalizeHttpUrl(item.profileUrl, item.platform);
  if (!profileUrl || !isPlatformProfileUrl(profileUrl, item.platform)) return null;
  const fallbackName = item.platform === "douyin" ? "抖音博主" : "哔站博主";
  const name = asBoundedString(item.name, MAX_FEED_NAME_LENGTH) ?? fallbackName;
  const knownNameSource = item.nameSource === "manual" || item.nameSource === "fallback" || item.nameSource === "platform";
  const nameSource = version >= 2 && knownNameSource
    ? item.nameSource
    : name === fallbackName ? "fallback" : "manual";
  const avatarUrl = normalizeHttpUrl(item.avatarUrl);
  return {
    id,
    platform: item.platform,
    profileUrl,
    name,
    nameSource,
    ...(avatarUrl ? { avatarUrl } : {}),
    enabled: typeof item.enabled === "boolean" ? item.enabled : true,
    ...(asBoundedString(item.lastSyncAt, MAX_FEED_DATE_LENGTH) ? { lastSyncAt: asBoundedString(item.lastSyncAt, MAX_FEED_DATE_LENGTH) } : {}),
    ...(asBoundedString(item.syncError, MAX_FEED_SYNC_ERROR_LENGTH) ? { syncError: asBoundedString(item.syncError, MAX_FEED_SYNC_ERROR_LENGTH) } : {}),
  };
}

function migrateVideo(value: unknown): VideoItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<VideoItem>;
  const id = asBoundedString(item.id, MAX_FEED_ID_LENGTH);
  if (!id) return null;
  if (item.platform !== "douyin" && item.platform !== "bilibili") return null;
  const videoUrl = normalizeHttpUrl(item.videoUrl, item.platform);
  if (!videoUrl || !isPlatformVideoUrl(videoUrl, item.platform)) return null;
  const creatorId = asBoundedString(item.creatorId, MAX_FEED_ID_LENGTH);
  if (!creatorId) return null;
  const title = asBoundedString(item.title, MAX_FEED_TITLE_LENGTH) ?? "未命名视频";
  const source = typeof item.source === "string" && VALID_SOURCES.has(item.source) ? item.source as VideoItem["source"] : "manual";
  const createdAt = asBoundedString(item.createdAt, MAX_FEED_DATE_LENGTH)
    || asBoundedString(item.publishedAt, MAX_FEED_DATE_LENGTH)
    || "1970-01-01T00:00:00.000Z";
  const coverUrl = normalizeHttpUrl(item.coverUrl);
  return {
    id,
    platform: item.platform,
    videoUrl,
    creatorId,
    title,
    ...(coverUrl ? { coverUrl } : {}),
    ...(asBoundedString(item.publishedAt, MAX_FEED_DATE_LENGTH) ? { publishedAt: asBoundedString(item.publishedAt, MAX_FEED_DATE_LENGTH) } : {}),
    ...(asBoundedString(item.duration, MAX_FEED_DURATION_LENGTH) ? { duration: asBoundedString(item.duration, MAX_FEED_DURATION_LENGTH) } : {}),
    source,
    createdAt,
  };
}

function canonicalFeedSyncId(video: VideoItem) {
  if (video.source !== "feed-sync") return video.id;
  const identity = getPlatformVideoIdentity(video.videoUrl, video.platform);
  if (!identity) return video.id;
  const partSuffix = video.platform === "bilibili" && identity.page > 1 ? `-p${identity.page}` : "";
  return `sync-${video.platform}-${identity.id}${partSuffix}`;
}

const VIDEO_SOURCE_PRIORITY: Record<VideoItem["source"], number> = {
  manual: 3,
  "public-metadata": 2,
  "feed-sync": 1,
  sample: 0,
};

function mergeRecoveredVideos(existing: VideoItem, incoming: VideoItem): VideoItem {
  const preferred = VIDEO_SOURCE_PRIORITY[incoming.source] > VIDEO_SOURCE_PRIORITY[existing.source]
    ? incoming
    : existing;
  const secondary = preferred === existing ? incoming : existing;
  return {
    ...preferred,
    ...(preferred.coverUrl || secondary.coverUrl ? { coverUrl: preferred.coverUrl ?? secondary.coverUrl } : {}),
    ...(preferred.publishedAt || secondary.publishedAt ? { publishedAt: preferred.publishedAt ?? secondary.publishedAt } : {}),
    ...(preferred.duration || secondary.duration ? { duration: preferred.duration ?? secondary.duration } : {}),
  };
}

function normalizeFeedState(value: unknown, recoverStoredRecords: boolean) {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { creators?: unknown; videos?: unknown; version?: unknown };
  if (!Array.isArray(candidate.creators) || !Array.isArray(candidate.videos)) return null;
  if (candidate.creators.length > MAX_FEED_CREATORS || candidate.videos.length > MAX_FEED_VIDEOS) return null;
  const rawVersion = candidate.version === undefined ? 1 : Number(candidate.version);
  if (rawVersion !== 1 && rawVersion !== 2) return null;

  const migratedCreators: Creator[] = [];
  const creatorById = new Map<string, Creator>();
  const creatorIdByIdentity = new Map<string, string>();
  const creatorIdAliases = new Map<string, string>();
  let repaired = 0;
  for (const rawCreator of candidate.creators) {
    const creator = migrateCreator(rawCreator, rawVersion);
    const urlKey = creator ? getFeedCreatorIdentityKey(creator.profileUrl, creator.platform) : undefined;
    if (!creator || !urlKey) {
      if (!recoverStoredRecords) return null;
      repaired += 1;
      continue;
    }
    const existingId = creatorById.has(creator.id) ? creator.id : creatorIdByIdentity.get(urlKey);
    if (existingId) {
      if (!recoverStoredRecords) return null;
      repaired += 1;
      creatorIdAliases.set(creator.id, existingId);
      continue;
    }
    creatorById.set(creator.id, creator);
    creatorIdByIdentity.set(urlKey, creator.id);
    migratedCreators.push(creator);
  }

  const migratedVideos: VideoItem[] = [];
  const videoIds = new Set<string>();
  const videoIndexByIdentity = new Map<string, number>();
  for (const rawVideo of candidate.videos) {
    const migrated = migrateVideo(rawVideo);
    if (!migrated) {
      if (!recoverStoredRecords) return null;
      repaired += 1;
      continue;
    }

    const creatorId = creatorIdAliases.get(migrated.creatorId) ?? migrated.creatorId;
    const creator = creatorById.get(creatorId);
    if (!creator || creator.platform !== migrated.platform) {
      if (!recoverStoredRecords) return null;
      repaired += 1;
      continue;
    }

    const attached = creatorId === migrated.creatorId ? migrated : { ...migrated, creatorId };
    if (attached.creatorId !== migrated.creatorId) repaired += 1;
    const canonicalId = canonicalFeedSyncId(attached);
    const normalized = canonicalId === attached.id ? attached : { ...attached, id: canonicalId };
    if (canonicalId !== attached.id) repaired += 1;
    const urlKey = getFeedVideoIdentityKey(normalized.videoUrl, normalized.platform);
    const existingIndex = videoIndexByIdentity.get(urlKey);
    if (existingIndex !== undefined) {
      if (!recoverStoredRecords) return null;
      repaired += 1;
      const existing = migratedVideos[existingIndex];
      videoIds.delete(existing.id);
      const preferred = mergeRecoveredVideos(existing, normalized);
      const merged = videoIds.has(preferred.id)
        ? { ...preferred, id: existing.id }
        : preferred;
      migratedVideos[existingIndex] = merged;
      videoIds.add(merged.id);
      continue;
    }
    if (videoIds.has(normalized.id)) {
      if (!recoverStoredRecords) return null;
      repaired += 1;
      continue;
    }
    videoIds.add(normalized.id);
    videoIndexByIdentity.set(urlKey, migratedVideos.length);
    migratedVideos.push(normalized);
  }

  return {
    state: {
      version: 2 as const,
      creators: migratedCreators,
      videos: migratedVideos,
    },
    repaired,
  };
}

export function migrateFeedState(value: unknown): FeedState | null {
  return normalizeFeedState(value, false)?.state ?? null;
}

export type FeedRecoveryResult = {
  state: FeedState;
  repaired: number;
};

export function recoverFeedState(value: unknown): FeedRecoveryResult | null {
  return normalizeFeedState(value, true);
}

export function isPlatformVideoUrl(value: unknown, platform: Creator["platform"]) {
  const normalized = normalizeHttpUrl(value, platform);
  if (!normalized) return false;
  const pathname = new URL(normalized).pathname;
  return platform === "bilibili"
    ? /^\/video\/BV[0-9A-Za-z]{8,20}(?:\/|$)/i.test(pathname)
    : /^\/video\/\d{10,}(?:\/|$)/.test(pathname);
}

export function normalizeFeedMediaUrl(value: unknown) {
  return normalizeHttpUrl(value);
}

export function isPlatformProfileUrl(value: unknown, platform: Creator["platform"]) {
  const normalized = normalizeHttpUrl(value, platform);
  if (!normalized) return false;
  const url = new URL(normalized);
  if (platform === "douyin") return /^\/user\/[^/]+\/?$/i.test(url.pathname);
  return (url.hostname === "space.bilibili.com" && /^\/\d+(?:\/.*)?$/.test(url.pathname))
    || /^\/space\/\d+(?:\/.*)?$/.test(url.pathname);
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地数据库打开失败"));
  });
}

export async function readFeedState(): Promise<StoredFeedState | null> {
  const database = await openDatabase();
  try {
    return await new Promise<StoredFeedState | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(FEED_KEY);
      request.onsuccess = () => {
        if (request.result === undefined) {
          resolve(null);
          return;
        }
        const raw = request.result as { revision?: unknown };
        const strict = normalizeFeedState(raw, false);
        const normalized = strict ?? recoverFeedState(raw);
        if (!normalized) {
          reject(new Error("本地数据库中的关注数据格式损坏"));
          return;
        }
        const rawVersion = raw && typeof raw === "object" && "version" in raw
          ? Number((raw as { version?: unknown }).version)
          : 1;
        const rawRevision = Number(raw.revision);
        const revision = Number.isSafeInteger(rawRevision) && rawRevision >= 0
          ? rawRevision
          : 0;
        const recovered = rawVersion !== 2 || !strict || normalized.repaired > 0;
        resolve({
          ...normalized.state,
          revision,
          ...(recovered ? {
            recoveryMessage: normalized.repaired
              ? `已隔离或修复 ${normalized.repaired} 条异常数据记录，其余本地数据已恢复。`
              : "本地视频索引已自动修复。",
            needsRewrite: true,
          } : {}),
        });
      };
      request.onerror = () => reject(request.error ?? new Error("本地数据读取失败"));
    });
  } finally {
    database.close();
  }
}

export async function writeFeedState(
  creators: unknown[],
  videos: unknown[],
  expectedRevision: number,
  writerId: string,
) {
  const normalized = normalizeFeedState({ version: 2, creators, videos }, false);
  if (!normalized) throw new Error("当前数据未通过完整性校验，已停止保存");
  const database = await openDatabase();
  try {
    return await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(FEED_KEY);
      let nextRevision = expectedRevision;
      let conflict: FeedStorageConflictError | null = null;
      request.onsuccess = () => {
        const current = request.result as { revision?: unknown } | undefined;
        const rawRevision = Number(current?.revision);
        const actualRevision = Number.isSafeInteger(rawRevision) && rawRevision >= 0
          ? rawRevision
          : 0;
        if (actualRevision !== expectedRevision) {
          conflict = new FeedStorageConflictError(actualRevision);
          transaction.abort();
          return;
        }
        nextRevision = actualRevision + 1;
        store.put({ ...normalized.state, revision: nextRevision, writerId }, FEED_KEY);
      };
      request.onerror = () => reject(request.error ?? new Error("本地数据读取失败"));
      transaction.oncomplete = () => resolve(nextRevision);
      transaction.onerror = () => reject(transaction.error ?? new Error("本地数据保存失败"));
      transaction.onabort = () => reject(conflict ?? transaction.error ?? new Error("本地数据保存失败"));
    });
  } finally {
    database.close();
  }
}
