import "server-only";

import { extractBvidFromPathname, isValidBvid } from "@/lib/bilibili-id";
import { createVideoId } from "@/lib/sync-video-id";
import {
  asRecord,
  asString,
  createAbortError,
  firstString,
  formatDuration,
  isTransientRequestError,
  normalizeCreatorProfile,
  normalizeMediaUrl,
  normalizePlatformVideoUrl,
  throwIfAborted,
  toIsoDate,
  unwrapPayload,
  waitWithSignal,
  type CreatorInput,
  type NormalizedVideo,
  type SyncedCreator,
} from "@/lib/server/feed-sync-shared";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SIDECAR_ATTEMPTS = 3;
const RETRY_DELAY_MS = 700;
const SIDECAR_HEALTH_TIMEOUT_MS = 2_000;
const MAX_BILIBILI_PAGES = 1_000;
const MAX_BILIBILI_VIDEOS = 150_000;

function isRetryableSidecarStatus(status: number) {
  return status === 408 || (status >= 500 && status <= 599);
}

export class SidecarRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SidecarRequestError";
    this.retryable = isRetryableSidecarStatus(status);
  }
}

export function isRetryableSidecarError(error: unknown): error is SidecarRequestError {
  return error instanceof SidecarRequestError && error.retryable;
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

export function getSidecarBaseUrl() {
  const raw = process.env.FEED_SIDECAR_URL?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)
      || !isLoopbackHost(url.hostname)
      || url.username
      || url.password) {
      return null;
    }
    // Only the origin is meaningful: every request is built by resolving a relative
    // path against the base, so a configured path prefix would be dropped for
    // /openapi.json but kept for the API calls.
    return url.origin;
  } catch {
    return null;
  }
}

const TOKEN_MISMATCH_MESSAGE = "本机抓取服务令牌不匹配，请重新运行本机抓取服务配置脚本；轮换令牌后需要重启网站";

function sidecarErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return "哔站本机抓取服务未启动或无法连接，请先运行 npm run start:local";
  }
  if (/unauthorized|forbidden/i.test(message)) return TOKEN_MISMATCH_MESSAGE;
  return message;
}

async function discardBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing a probe response body is best effort only.
  }
}

async function probeRequest(url: URL, token: string | null, signal?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), SIDECAR_HEALTH_TIMEOUT_MS);
  try {
    throwIfAborted(signal);
    return await fetch(url, {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("哔站本机抓取服务响应超时");
    }
    throw new Error(sidecarErrorMessage(error));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Verifies that the sidecar is reachable *and* that the configured bearer token is
 * accepted. `/openapi.json` is exempt from the sidecar's auth middleware, so a
 * successful discovery request alone says nothing about the token.
 */
export async function probeSidecar(baseUrl: string, signal?: AbortSignal) {
  const openApiResponse = await probeRequest(new URL("openapi.json", `${baseUrl}/`), null, signal);
  await discardBody(openApiResponse);
  if (!openApiResponse.ok) {
    throw new SidecarRequestError(`抓取服务返回 ${openApiResponse.status}`, openApiResponse.status);
  }

  const token = process.env.FEED_SIDECAR_TOKEN?.trim();
  if (!token) {
    throw new Error("未配置本机抓取服务令牌，请重新运行本机抓取服务配置脚本");
  }
  const authProbeUrl = new URL("__local_auth_probe__", `${baseUrl}/`);
  const unauthenticated = await probeRequest(authProbeUrl, null, signal);
  await discardBody(unauthenticated);
  if (unauthenticated.status !== 401) {
    if (unauthenticated.status === 408 || unauthenticated.status === 429 || unauthenticated.status >= 500) {
      throw new SidecarRequestError(`抓取服务返回 ${unauthenticated.status}`, unauthenticated.status);
    }
    throw new Error("本机抓取服务未启用鉴权，请重新运行本机抓取服务配置脚本");
  }
  const authenticated = await probeRequest(authProbeUrl, token, signal);
  await discardBody(authenticated);
  if (authenticated.status === 401) throw new Error(TOKEN_MISMATCH_MESSAGE);
  if (authenticated.status === 408 || authenticated.status === 429 || authenticated.status >= 500) {
    throw new SidecarRequestError(`抓取服务返回 ${authenticated.status}`, authenticated.status);
  }
  if (authenticated.status === 403) throw new Error(TOKEN_MISMATCH_MESSAGE);
  if (!authenticated.ok && authenticated.status !== 404) {
    throw new Error("本机抓取服务鉴权探针异常");
  }
}

function assertSuccessfulPayload(value: unknown) {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const record = asRecord(current);
    const code = Number(record.code);
    if (Number.isFinite(code) && code !== 0 && code !== 200) {
      throw new Error(firstString(record.message) || `抓取服务业务错误 ${code}`);
    }
    const statusCode = Number(record.status_code);
    if (Number.isFinite(statusCode) && statusCode !== 0) {
      throw new Error(
        firstString(record.status_msg, record.message) || `平台返回错误 ${statusCode}`,
      );
    }
    if (!("data" in record)) break;
    current = record.data;
  }
}

async function fetchSidecarJson(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
) {
  const url = new URL(path, `${baseUrl}/`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const token = process.env.FEED_SIDECAR_TOKEN?.trim();

  let lastError: unknown = new Error("抓取服务请求失败");
  for (let attempt = 0; attempt < MAX_SIDECAR_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403) {
        await discardBody(response);
        throw new Error(TOKEN_MISMATCH_MESSAGE);
      }
      if (!response.ok) {
        let detail = "";
        try {
          const errorPayload = asRecord(await response.json());
          detail = firstString(errorPayload.message, errorPayload.detail, errorPayload.error);
        } catch {
          // The status code is enough when the sidecar does not return JSON.
        }
        const error = new SidecarRequestError(
          detail || `抓取服务返回 ${response.status}`,
          response.status,
        );
        if (attempt + 1 < MAX_SIDECAR_ATTEMPTS && error.retryable) {
          lastError = error;
          await waitWithSignal(RETRY_DELAY_MS * (attempt + 1), signal);
          continue;
        }
        throw error;
      }
      const payload = await response.json() as unknown;
      assertSuccessfulPayload(payload);
      return payload;
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      lastError = error instanceof Error && error.name === "AbortError"
        ? new Error(timedOut ? "抓取服务响应超时" : "抓取服务请求已取消")
        : error;
      if (attempt + 1 < MAX_SIDECAR_ATTEMPTS && isTransientRequestError(lastError)) {
        await waitWithSignal(RETRY_DELAY_MS * (attempt + 1), signal);
        continue;
      }
      if (lastError instanceof SidecarRequestError) throw lastError;
      throw new Error(sidecarErrorMessage(lastError));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new Error(sidecarErrorMessage(lastError));
}

function getBilibiliBvid(item: Record<string, unknown>) {
  const directBvid = [item.bvid, item.bv_id, item.id]
    .map(asString)
    .find((candidate) => isValidBvid(candidate));
  if (directBvid) return directBvid;

  const arcUrl = normalizePlatformVideoUrl(item.arcurl, "bilibili");
  if (!arcUrl) return "";
  return extractBvidFromPathname(new URL(arcUrl).pathname) ?? "";
}

function getBilibiliUid(profileUrl: string) {
  const url = new URL(profileUrl);
  return url.pathname.match(/\/(\d+)(?:\/|$)/)?.[1] ?? "";
}

function getBilibiliPage(
  payload: unknown,
  creator: CreatorInput,
  syncedAt: string,
) {
  const root = asRecord(unwrapPayload(payload));
  const nested = asRecord(root.data);
  const listCandidates = [
    root.list,
    nested.list,
    root.vlist,
    nested.vlist,
    asRecord(root.list).vlist,
    asRecord(nested.list).vlist,
  ];
  const list = listCandidates.find(Array.isArray) as unknown[] | undefined;
  if (!list) throw new Error("抓取服务未返回可识别的哔站投稿列表");

  const videos = list.map((value, index): NormalizedVideo => {
    const item = asRecord(value);
    const bvid = getBilibiliBvid(item);
    if (!bvid) {
      throw new Error(`哔站第 ${index + 1} 条投稿缺少有效 BVID，未完整同步`);
    }
    const videoUrl = `https://www.bilibili.com/video/${bvid}`;
    const title = firstString(item.title, item.name) || "未命名视频";
    return {
      id: createVideoId("bilibili", videoUrl),
      platform: "bilibili",
      videoUrl,
      creatorId: creator.id,
      title,
      coverUrl: normalizeMediaUrl(firstString(item.pic, item.cover)) || undefined,
      publishedAt: toIsoDate(item.created ?? item.pubdate),
      duration: firstString(item.length, formatDuration(item.duration)) || undefined,
      source: "feed-sync",
      createdAt: syncedAt,
    };
  });
  const page = asRecord(root.page);
  const hasExplicitSafeInteger = (value: unknown, minimum: number) => {
    if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return false;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum;
  };
  return {
    videos,
    rawCount: list.length,
    pageNumber: Number(page.pn),
    pageSize: Number(page.ps),
    total: Number(page.count),
    hasPageNumber: hasExplicitSafeInteger(page.pn, 1),
    hasPageSize: hasExplicitSafeInteger(page.ps, 1),
    hasTotal: hasExplicitSafeInteger(page.count, 0),
    signature: videos.map((video) => video.videoUrl).join("|"),
  };
}

async function getAllBilibiliVideos(
  baseUrl: string,
  creator: CreatorInput,
  syncedAt: string,
  signal?: AbortSignal,
) {
  const uid = getBilibiliUid(creator.profileUrl);
  if (!uid) throw new Error("哔站主页链接需包含数字 UID");

  const videos = new Map<string, NormalizedVideo>();
  const seenPages = new Set<string>();
  let expectedTotal: number | undefined;
  let requestedPage = 1;

  while (true) {
    if (requestedPage > MAX_BILIBILI_PAGES) {
      throw new Error("哔站分页超过安全上限，未完整同步");
    }
    throwIfAborted(signal);
    const payload = await fetchSidecarJson(
      baseUrl,
      "api/bilibili/web/fetch_user_post_videos",
      { uid, pn: String(requestedPage) },
      signal,
    );
    const page = getBilibiliPage(payload, creator, syncedAt);
    if (!page.hasPageNumber || !page.hasPageSize || !page.hasTotal) {
      throw new Error("哔站分页元数据不完整，未完整同步");
    }
    if (page.pageNumber !== requestedPage) {
      throw new Error("哔站分页页码与请求不一致，未完整同步");
    }
    const reportedTotal = page.total;
    if (expectedTotal !== undefined && reportedTotal !== expectedTotal) {
      throw new Error("哔站投稿总数在同步过程中发生变化，未完整同步");
    }
    expectedTotal = reportedTotal;
    if (page.rawCount === 0) {
      if (expectedTotal !== 0 || videos.size !== expectedTotal) {
        throw new Error("哔站分页提前结束，未读取全部投稿");
      }
      break;
    }
    if (seenPages.has(page.signature)) {
      throw new Error("哔站分页重复，未能确认已读取全部投稿");
    }
    seenPages.add(page.signature);
    page.videos.forEach((video) => videos.set(video.videoUrl, video));
    if (videos.size > MAX_BILIBILI_VIDEOS) {
      throw new Error("哔站投稿超过安全上限，未完整同步");
    }

    const pageNumber = page.pageNumber;
    if (pageNumber * page.pageSize >= reportedTotal) {
      if (videos.size !== reportedTotal) {
        throw new Error("哔站返回的投稿数量与总数不一致，未完整同步");
      }
      break;
    }
    requestedPage = pageNumber + 1;
  }

  return Array.from(videos.values());
}

async function getBilibiliProfile(
  baseUrl: string,
  creator: CreatorInput,
  signal?: AbortSignal,
) {
  const uid = getBilibiliUid(creator.profileUrl);
  if (!uid) return undefined;
  try {
    throwIfAborted(signal);
    const payload = await fetchSidecarJson(
      baseUrl,
      "api/bilibili/web/fetch_user_profile",
      { uid },
      signal,
    );
    const root = asRecord(unwrapPayload(payload));
    return normalizeCreatorProfile(root.name, root.face ?? root.avatar);
  } catch {
    if (signal?.aborted) throw createAbortError();
    // Profile metadata is optional; video pagination remains authoritative.
    return undefined;
  }
}

export async function syncBilibiliCreator(
  baseUrl: string,
  creator: CreatorInput,
  syncedAt: string,
  signal?: AbortSignal,
): Promise<SyncedCreator> {
  const videos = await getAllBilibiliVideos(baseUrl, creator, syncedAt, signal);
  const profile = await getBilibiliProfile(baseUrl, creator, signal);
  return { videos, profile, mode: "snapshot" };
}
