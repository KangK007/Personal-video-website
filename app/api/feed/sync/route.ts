import { NextResponse } from "next/server";
import {
  DouyinSyncError,
  getDouyinFailureCode,
  isRetryableDouyinError,
  openDouyinBrowserSession,
  type DouyinBrowserSession,
} from "@/lib/douyin-browser";
import { LocalApiRequestError, readLocalJsonRequest } from "@/lib/local-api-request";
import {
  getSidecarBaseUrl,
  probeSidecar,
  syncBilibiliCreator,
} from "@/lib/server/bilibili-sync";
import {
  asRecord,
  asString,
  createAbortError,
  firstImageUrl,
  firstString,
  formatDuration,
  isPlatformProfileUrl,
  isTransientRequestError,
  normalizeCreatorProfile,
  normalizeMediaUrl,
  normalizeProfileUrl,
  throwIfAborted,
  toIsoDate,
  unwrapPayload,
  waitWithSignal,
  type CreatorInput,
  type CreatorProfile,
  type NormalizedVideo,
  type SyncedCreator,
  type SyncResult,
} from "@/lib/server/feed-sync-shared";
import { createVideoId } from "@/lib/sync-video-id";

export const runtime = "nodejs";

const MAX_CREATORS = 30;
const MAX_DOUYIN_CREATORS = 3;
const MAX_REQUEST_BODY_BYTES = 128 * 1024;
const MAX_KNOWN_VIDEO_IDS = 100;
const DOUYIN_RETRY_DELAYS_MS = [15_000, 30_000] as const;
const DOUYIN_CREATOR_COOLDOWN_MIN_MS = 8_000;
const DOUYIN_CREATOR_COOLDOWN_RANGE_MS = 6_000;

type SyncProcessState = typeof globalThis & {
  __justFollowFeedSyncRunning?: boolean;
};

function tryAcquireSyncLock() {
  const state = globalThis as SyncProcessState;
  if (state.__justFollowFeedSyncRunning) return null;
  state.__justFollowFeedSyncRunning = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.__justFollowFeedSyncRunning = false;
  };
}

function getDouyinVideos(payload: unknown, creator: CreatorInput, syncedAt: string) {
  const root = asRecord(unwrapPayload(payload));
  const nested = asRecord(root.data);
  const listCandidates = [
    root.aweme_list,
    nested.aweme_list,
    root.list,
    nested.list,
  ];
  const list = listCandidates.find(Array.isArray) as unknown[] | undefined;
  if (!list) throw new Error("抓取服务未返回可识别的抖音投稿列表");

  return list.map((value, index): NormalizedVideo => {
    const item = asRecord(value);
    const videoId = [item.aweme_id, item.awemeId, item.id]
      .map(asString)
      .find((candidate) => /^\d+$/.test(candidate)) ?? "";
    if (!videoId) {
      throw new Error(`抖音第 ${index + 1} 条投稿缺少有效作品 ID，未完整同步`);
    }
    const video = asRecord(item.video);
    const title = firstString(item.desc, asRecord(item.share_info).share_title) || "未命名视频";
    const videoUrl = `https://www.douyin.com/video/${videoId}`;
    return {
      id: createVideoId("douyin", videoUrl),
      platform: "douyin",
      videoUrl,
      creatorId: creator.id,
      title,
      coverUrl: firstString(
        firstImageUrl(video.cover),
        firstImageUrl(video.origin_cover),
        firstImageUrl(video.dynamic_cover),
        normalizeMediaUrl(video.cover_url),
      ) || undefined,
      publishedAt: toIsoDate(item.create_time),
      duration: formatDuration(video.duration, "milliseconds"),
      source: "feed-sync",
      createdAt: syncedAt,
    };
  });
}

function getDouyinProfile(payload: unknown): CreatorProfile | undefined {
  const root = asRecord(unwrapPayload(payload));
  const list = (Array.isArray(root.aweme_list) ? root.aweme_list : []) as unknown[];
  for (const value of list) {
    const item = asRecord(value);
    const author = asRecord(item.author);
    const profile = normalizeCreatorProfile(
      firstString(author.nickname, author.unique_id, author.short_id),
      firstImageUrl(author.avatar_thumb)
        || firstImageUrl(author.avatar_medium)
        || firstImageUrl(author.avatar_larger),
    );
    if (profile) return profile;
  }
  return undefined;
}

async function fetchDouyinWithRetry(
  session: DouyinBrowserSession,
  profileUrl: string,
  knownVideoIds: ReadonlySet<string>,
  signal?: AbortSignal,
) {
  let lastError: unknown;
  let consecutiveRestrictedResponses = 0;
  for (let attempt = 0; attempt < DOUYIN_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await session.fetchUserPosts(profileUrl, knownVideoIds, signal);
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      lastError = error;
      consecutiveRestrictedResponses = isRetryableDouyinError(error)
        ? consecutiveRestrictedResponses + 1
        : 0;
      if (consecutiveRestrictedResponses >= 3) {
        throw new DouyinSyncError(
          "抖音连续 3 次返回空白或异常数据，本轮同步已停止；请稍后再试",
          "douyin_circuit_open",
        );
      }
      if (
        attempt < DOUYIN_RETRY_DELAYS_MS.length
        && (isRetryableDouyinError(error) || isTransientRequestError(error))
      ) {
        const jitter = Math.floor(Math.random() * 5_001);
        await waitWithSignal(DOUYIN_RETRY_DELAYS_MS[attempt] + jitter, signal);
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("抖音同步失败");
}

async function syncCreator(
  baseUrl: string | null,
  sidecarError: string | null,
  douyinBrowser: DouyinBrowserSession | null,
  douyinBrowserError: string | null,
  creator: CreatorInput,
  syncedAt: string,
  signal?: AbortSignal,
) {
  if (creator.platform === "bilibili") {
    if (!baseUrl) throw new Error("未配置哔站本机抓取服务");
    if (sidecarError) throw new Error(sidecarError);
    return syncBilibiliCreator(baseUrl, creator, syncedAt, signal);
  }

  if (!douyinBrowser) throw new Error(douyinBrowserError || "未配置抖音浏览器同步");
  const fetched = await fetchDouyinWithRetry(
    douyinBrowser,
    creator.profileUrl,
    new Set(creator.knownVideoIds),
    signal,
  );
  return {
    videos: getDouyinVideos(fetched.payload, creator, syncedAt),
    profile: getDouyinProfile(fetched.payload),
    mode: fetched.mode,
  } satisfies SyncedCreator;
}

async function runSync(request: Request, creators: CreatorInput[]) {
  const baseUrl = getSidecarBaseUrl();
  const syncedAt = new Date().toISOString();
  let sidecarError: string | null = null;
  if (creators.some((creator) => creator.platform === "bilibili")) {
    if (!baseUrl) {
      sidecarError = "未配置哔站本机抓取服务，请先运行 npm run start:local";
    } else {
      try {
        await probeSidecar(baseUrl, request.signal);
      } catch (error) {
        if (request.signal.aborted) {
          return NextResponse.json({ error: "同步已取消" }, { status: 499 });
        }
        sidecarError = error instanceof Error ? error.message : "哔站本机抓取服务不可用";
      }
    }
  }
  let douyinBrowser: DouyinBrowserSession | null = null;
  let douyinBrowserError: string | null = null;
  if (creators.some((creator) => creator.platform === "douyin")) {
    try {
      douyinBrowser = await openDouyinBrowserSession(request.signal);
    } catch (error) {
      if (request.signal.aborted) {
        return NextResponse.json({ error: "同步已取消" }, { status: 499 });
      }
      douyinBrowserError = error instanceof Error ? error.message : "抖音浏览器同步启动失败";
    }
  }

  const results: SyncResult[] = [];
  const videos: NormalizedVideo[] = [];
  let douyinCircuitOpen = false;
  try {
    for (let index = 0; index < creators.length; index += 1) {
      const creator = creators[index];
      if (request.signal.aborted) break;
      if (creator.platform === "douyin" && douyinCircuitOpen) {
        results.push({
          creatorId: creator.id,
          status: "error",
          count: 0,
          complete: false,
          mode: creator.knownVideoIds?.length ? "incremental" : "snapshot",
          failureCode: "douyin_circuit_open",
          message: "抖音连续返回异常数据，本轮已暂停后续抖音同步；请稍后再试",
        });
        continue;
      }
      try {
        const synced = await syncCreator(
          baseUrl,
          sidecarError,
          douyinBrowser,
          douyinBrowserError,
          creator,
          syncedAt,
          request.signal,
        );
        videos.push(...synced.videos);
        results.push({
          creatorId: creator.id,
          status: "success",
          count: synced.videos.length,
          complete: true,
          mode: synced.mode,
          ...(synced.profile ? { profile: synced.profile } : {}),
        });
      } catch (error) {
        if (request.signal.aborted) break;
        const failureCode = getDouyinFailureCode(error);
        if (failureCode === "douyin_circuit_open") douyinCircuitOpen = true;
        results.push({
          creatorId: creator.id,
          status: "error",
          count: 0,
          complete: false,
          mode: creator.knownVideoIds?.length ? "incremental" : "snapshot",
          message: error instanceof Error ? error.message : "同步失败",
          ...(failureCode ? { failureCode } : {}),
        });
      }
      const hasAnotherDouyinCreator = creators.slice(index + 1)
        .some((item) => item.platform === "douyin");
      if (creator.platform === "douyin" && hasAnotherDouyinCreator && !douyinCircuitOpen) {
        const delay = DOUYIN_CREATOR_COOLDOWN_MIN_MS
          + Math.floor(Math.random() * (DOUYIN_CREATOR_COOLDOWN_RANGE_MS + 1));
        try {
          await waitWithSignal(delay, request.signal);
        } catch (error) {
          if (!request.signal.aborted) throw error;
          break;
        }
      }
    }
  } finally {
    try {
      await douyinBrowser?.close();
    } catch {
      // Browser cleanup must not replace the synchronization result.
    }
  }

  if (request.signal.aborted) {
    return NextResponse.json({ error: "同步已取消" }, { status: 499 });
  }

  const hasSuccess = results.some((result) => result.status === "success");
  return NextResponse.json({
    configured: Boolean(baseUrl || douyinBrowser),
    syncedAt,
    videos,
    results,
  }, { status: hasSuccess || creators.length === 0 ? 200 : 502 });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed = await readLocalJsonRequest(request, MAX_REQUEST_BODY_BYTES);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "请求格式不正确" }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LocalApiRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "请求格式不正确" }, { status: 400 });
  }

  if (request.signal.aborted) {
    return NextResponse.json({ error: "同步已取消" }, { status: 499 });
  }
  if (!Array.isArray(body.creators) || body.creators.length > MAX_CREATORS) {
    return NextResponse.json({ error: `一次最多同步 ${MAX_CREATORS} 个关注博主` }, { status: 400 });
  }

  const creators: CreatorInput[] = [];
  const creatorIds = new Set<string>();
  for (const value of body.creators) {
    const item = asRecord(value);
    const profileUrl = normalizeProfileUrl(item.profileUrl);
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const knownVideoIds = Array.isArray(item.knownVideoIds)
      ? item.knownVideoIds.map(asString)
      : [];
    if (
      !profileUrl
      || (item.platform !== "douyin" && item.platform !== "bilibili")
      || !isPlatformProfileUrl(item.platform, profileUrl)
      || !id
      || id.length > 100
      || creatorIds.has(id)
      || typeof item.name !== "string"
      || !item.name.trim()
      || knownVideoIds.length > MAX_KNOWN_VIDEO_IDS
      || knownVideoIds.some((videoId) => !/^\d{5,30}$/.test(videoId))
      || new Set(knownVideoIds).size !== knownVideoIds.length
    ) {
      return NextResponse.json({ error: "关注名单中存在无效或重复的博主数据" }, { status: 400 });
    }
    creatorIds.add(id);
    creators.push({
      id,
      platform: item.platform,
      profileUrl,
      name: item.name.trim().slice(0, 80),
      knownVideoIds: item.platform === "douyin" ? knownVideoIds : [],
    });
  }
  if (creators.filter((creator) => creator.platform === "douyin").length > MAX_DOUYIN_CREATORS) {
    return NextResponse.json({
      error: `为降低平台风控风险，一次最多同步 ${MAX_DOUYIN_CREATORS} 位抖音博主`,
    }, { status: 400 });
  }

  const releaseSyncLock = tryAcquireSyncLock();
  if (!releaseSyncLock) {
    return NextResponse.json({ error: "已有同步任务正在进行，请等待完成后重试" }, { status: 409 });
  }

  try {
    return await runSync(request, creators);
  } finally {
    releaseSyncLock();
  }
}
