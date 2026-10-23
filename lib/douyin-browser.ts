import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from "playwright-core";
import {
  cleanFollowingName,
  followingAvatar,
  followingProfileUrl,
  FOLLOWING_LIMIT,
  validFollowingId,
  type FollowingCreator,
} from "@/lib/following-list";

const PAGE_TIMEOUT_MS = 30_000;
const MAX_COOKIE_BYTES = 64 * 1024;
// Playwright's close() waits for the browser process to exit; an unresponsive Edge
// can make it hang forever, which would keep the sync request (and its lock) alive.
// Never wait longer than this for cleanup.
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

export async function closeWithTimeout(target: { close: () => Promise<unknown> }, timeoutMs = BROWSER_CLOSE_TIMEOUT_MS) {
  const closing = target.close().catch(() => undefined);
  await Promise.race([
    closing,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

const POST_API_PATH = "/aweme/v1/web/aweme/post/";
const PROFILE_SCROLL_SELECTOR = ".route-scroll-container";

export type DouyinFailureCode =
  | "douyin_empty_response"
  | "douyin_invalid_response"
  | "douyin_rate_limited"
  | "douyin_circuit_open";

export class DouyinSyncError extends Error {
  constructor(
    message: string,
    public readonly code: DouyinFailureCode,
  ) {
    super(message);
    this.name = "DouyinSyncError";
  }
}

export type DouyinBrowserSession = {
  fetchUserPosts(
    profileUrl: string,
    knownVideoIds?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<DouyinPostsResult>;
  close(): Promise<void>;
};

export type DouyinPostsResult = {
  payload: unknown;
  mode: "snapshot" | "incremental";
};

export function isRetryableDouyinError(error: unknown) {
  return error instanceof DouyinSyncError && error.code !== "douyin_circuit_open";
}

export function getDouyinFailureCode(error: unknown) {
  return error instanceof DouyinSyncError ? error.code : undefined;
}

function createAbortError() {
  return typeof DOMException !== "undefined"
    ? new DOMException("同步已取消", "AbortError")
    : Object.assign(new Error("同步已取消"), { name: "AbortError" });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
}

function isDouyinHost(hostname: string) {
  return hostname === "douyin.com"
    || hostname.endsWith(".douyin.com")
    || hostname === "iesdouyin.com"
    || hostname.endsWith(".iesdouyin.com");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function isPostResponse(response: Response) {
  try {
    const url = new URL(response.url());
    return isDouyinHost(url.hostname)
      && url.pathname === POST_API_PATH;
  } catch {
    return false;
  }
}

export function parseDouyinPostPayload(body: string, status: number) {
  if (status === 403 || status === 429) {
    throw new DouyinSyncError(
      "抖音拒绝了投稿请求，疑似触发限流或登录状态异常",
      "douyin_rate_limited",
    );
  }
  if (status < 200 || status >= 300) {
    throw new DouyinSyncError(
      `抖音投稿接口返回 ${status}，疑似触发限流或登录状态异常`,
      "douyin_rate_limited",
    );
  }
  if (!body.trim()) {
    throw new DouyinSyncError(
      "抖音返回空白投稿数据，疑似触发限流或登录状态异常",
      "douyin_empty_response",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new DouyinSyncError(
      "抖音返回的投稿数据不完整，疑似触发限流或登录状态异常",
      "douyin_invalid_response",
    );
  }
  const record = asRecord(payload);
  if (Number(record.status_code) !== 0 || !Array.isArray(record.aweme_list)) {
    throw new DouyinSyncError(
      "抖音页面未返回可识别的投稿列表，可能需要重新登录或完成验证",
      "douyin_rate_limited",
    );
  }
  const hasMore = record.has_more === true || record.has_more === 1 || record.has_more === "1";
  const hasExplicitEnd = record.has_more === false || record.has_more === 0 || record.has_more === "0";
  if (record.aweme_list.length === 0 && !hasExplicitEnd) {
    throw new DouyinSyncError(
      "抖音返回未确认结束的空投稿列表，疑似触发限流或登录状态异常；已有缓存已保留",
      "douyin_empty_response",
    );
  }
  if (record.aweme_list.length > 0 && !hasMore && !hasExplicitEnd) {
    throw new DouyinSyncError(
      "抖音投稿分页状态缺失，响应不完整；已有缓存已保留",
      "douyin_invalid_response",
    );
  }
  if (record.aweme_list.some((item) => !/^\d+$/.test(String(asRecord(item).aweme_id ?? "")))) {
    throw new DouyinSyncError(
      "抖音投稿缺少有效作品 ID，响应不完整；已有缓存已保留",
      "douyin_invalid_response",
    );
  }
  const cursor = record.max_cursor === undefined || record.max_cursor === null
    ? null
    : String(record.max_cursor);
  return { payload: record, items: record.aweme_list, hasMore, cursor };
}

async function readPostPayload(response: Response) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    throw new DouyinSyncError(
      "抖音投稿响应读取失败，疑似触发限流或响应截断",
      "douyin_invalid_response",
    );
  }
  return parseDouyinPostPayload(body, response.status());
}

function isPinnedPost(value: unknown) {
  const item = asRecord(value);
  return item.is_top === true
    || Number(item.is_top) === 1
    || item.is_pinned === true
    || Number(item.is_pinned) === 1;
}

export function selectNewDouyinPosts(
  items: unknown[],
  knownVideoIds: ReadonlySet<string>,
) {
  const newItems: unknown[] = [];
  let reachedKnownBoundary = false;
  for (const item of items) {
    const id = String(asRecord(item).aweme_id ?? "");
    if (id && knownVideoIds.has(id)) {
      if (!isPinnedPost(item)) reachedKnownBoundary = true;
      continue;
    }
    newItems.push(item);
  }
  return { newItems, reachedKnownBoundary };
}

async function waitForNextPostResponse(page: Page, signal?: AbortSignal) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal);
    if (attempt > 0) {
      await page.locator(PROFILE_SCROLL_SELECTOR).evaluate((element) => {
        const scroller = element as HTMLElement;
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight * 2);
      });
      await page.waitForTimeout(300);
      throwIfAborted(signal);
    }
    const responsePromise = page.waitForResponse(isPostResponse, { timeout: PAGE_TIMEOUT_MS });
    // Attach a handler immediately: when the scroll container is missing the evaluate
    // below throws first, and an unawaited rejection would surface process-wide.
    responsePromise.catch(() => undefined);
    await page.locator(PROFILE_SCROLL_SELECTOR).evaluate((element) => {
      const scroller = element as HTMLElement;
      scroller.scrollTop = scroller.scrollHeight;
    });
    try {
      return await responsePromise;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function resolveBrowserExecutable() {
  const configured = process.env.DOUYIN_BROWSER_EXECUTABLE?.trim();
  const candidates = [
    configured,
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next standard browser location.
    }
  }
  throw new Error("未找到可用的 Microsoft Edge 或 Google Chrome");
}

async function readCookieHeader() {
  const configured = process.env.DOUYIN_COOKIE_FILE?.trim() || ".local/douyin-cookie.txt";
  const cookiePath = path.isAbsolute(configured)
    ? configured
    : path.join(/* turbopackIgnore: true */ process.cwd(), configured);
  let stat;
  try {
    stat = await fs.stat(cookiePath);
  } catch {
    throw new Error("未配置抖音 Cookie，请重新运行本机抓取服务配置脚本");
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_COOKIE_BYTES) {
    throw new Error("抖音 Cookie 文件格式不正确");
  }
  const value = (await fs.readFile(cookiePath, "utf8")).trim();
  if (!value || value.includes("\r") || value.includes("\n")) {
    throw new Error("抖音 Cookie 文件格式不正确");
  }
  return value;
}

function parseCookies(header: string, cookieDomain?: string) {
  return header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) return [];
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || /[\u0000-\u001f\u007f]/.test(name + value)) return [];
    return [cookieDomain
      ? { name, value, domain: cookieDomain, path: "/" }
      : { name, value, url: "https://www.douyin.com/" }];
  });
}

function getViewport(cookies: Array<{ name: string; value: string }>) {
  const value = cookies.find((cookie) => cookie.name === "browser_resolution")?.value;
  const match = value?.match(/^(\d{3,4})-(\d{3,4})$/);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (width >= 320 && width <= 3840 && height >= 480 && height <= 2160) {
    return { width, height };
  }
  return { width: 1365, height: 900 };
}

function buildUserAgent(browser: Browser, executablePath: string) {
  const major = browser.version().match(/^\d+/)?.[0] || "130";
  const edgeSuffix = path.basename(executablePath).toLowerCase() === "msedge.exe"
    ? ` Edg/${major}.0.0.0`
    : "";
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${edgeSuffix}`;
}

export async function createContext(browser: Browser, executablePath: string, cookieHeader: string, cookieDomain?: string) {
  const cookies = parseCookies(cookieHeader, cookieDomain);
  if (cookies.length === 0) throw new Error("Cookie 文件中没有可用字段");
  const context = await browser.newContext({
    userAgent: buildUserAgent(browser, executablePath),
    viewport: getViewport(cookies),
    locale: "zh-CN",
  });
  try {
    await context.addCookies(cookies);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
  } catch (error) {
    await closeWithTimeout(context);
    throw error;
  }
  return context;
}

async function fetchUserPosts(
  context: BrowserContext,
  profileUrl: string,
  knownVideoIds: ReadonlySet<string>,
  signal?: AbortSignal,
) {
  const page = await context.newPage();
  let readingPagination = false;
  const onAbort = () => {
    void page.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    const responsePromise = page.waitForResponse(isPostResponse, { timeout: PAGE_TIMEOUT_MS });

    const [, response] = await Promise.all([
      page.goto(profileUrl, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      }),
      responsePromise,
    ]);
    throwIfAborted(signal);
    const finalUrl = new URL(page.url());
    if (!isDouyinHost(finalUrl.hostname) || !finalUrl.pathname.startsWith("/user/")) {
      throw new Error("抖音主页链接未跳转到有效用户页面");
    }

    const firstPage = await readPostPayload(response);
    const allItems: unknown[] = [];
    const allSnapshotItems: unknown[] = [];
    const seenIds = new Set<string>();
    const seenSnapshotIds = new Set<string>();
    const seenCursors = new Set<string>();

    const addItems = (items: unknown[]) => {
      let added = 0;
      const selected = selectNewDouyinPosts(items, knownVideoIds);
      for (const item of items) {
        const id = String(asRecord(item).aweme_id ?? "");
        if (!id || seenSnapshotIds.has(id)) continue;
        seenSnapshotIds.add(id);
        allSnapshotItems.push(item);
      }
      for (const item of selected.newItems) {
        const id = String(asRecord(item).aweme_id ?? "");
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        allItems.push(item);
        added += 1;
      }
      return { added, reachedKnownBoundary: selected.reachedKnownBoundary };
    };

    let selectedPage = addItems(firstPage.items);
    let currentPage = firstPage;
    if (currentPage.hasMore && !selectedPage.reachedKnownBoundary) {
      if (currentPage.cursor === null) throw new Error("抖音分页游标缺失，未完整同步");
      seenCursors.add(currentPage.cursor);
    }

    while (currentPage.hasMore && !selectedPage.reachedKnownBoundary) {
      throwIfAborted(signal);
      readingPagination = true;
      await page.waitForFunction((selector) => {
        const scroller = document.querySelector(selector);
        return scroller instanceof HTMLElement && scroller.scrollHeight > scroller.clientHeight;
      }, PROFILE_SCROLL_SELECTOR, { timeout: PAGE_TIMEOUT_MS });
      const previousHeight = await page.locator(PROFILE_SCROLL_SELECTOR).evaluate(
        (element) => (element as HTMLElement).scrollHeight,
      );
      const nextResponse = await waitForNextPostResponse(page, signal);
      const nextPage = await readPostPayload(nextResponse);
      throwIfAborted(signal);
      selectedPage = addItems(nextPage.items);
      if (nextPage.hasMore && !selectedPage.reachedKnownBoundary && nextPage.cursor === null) {
        throw new Error("抖音分页游标缺失，未完整同步");
      }
      if (
        nextPage.hasMore
        && !selectedPage.reachedKnownBoundary
        && nextPage.cursor !== null
        && seenCursors.has(nextPage.cursor)
      ) {
        throw new Error("抖音分页游标重复，未完整同步");
      }
      const { added } = selectedPage;
      if (nextPage.hasMore && (nextPage.items.length === 0 || added === 0)) {
        if (selectedPage.reachedKnownBoundary) {
          currentPage = nextPage;
          break;
        }
        throw new Error("抖音分页未返回新投稿，未完整同步");
      }
      if (nextPage.hasMore && !selectedPage.reachedKnownBoundary) {
        if (nextPage.cursor === null) throw new Error("抖音分页游标缺失，未完整同步");
        seenCursors.add(nextPage.cursor);
        await page.waitForFunction(({ selector, height }) => {
          const scroller = document.querySelector(selector);
          return scroller instanceof HTMLElement && scroller.scrollHeight > height;
        }, { selector: PROFILE_SCROLL_SELECTOR, height: previousHeight }, { timeout: PAGE_TIMEOUT_MS });
      }
      currentPage = nextPage;
    }

    const incremental = knownVideoIds.size > 0 && selectedPage.reachedKnownBoundary;
    return {
      payload: {
        ...firstPage.payload,
        aweme_list: incremental ? allItems : allSnapshotItems,
        has_more: 0,
      },
      mode: incremental ? "incremental" : "snapshot",
    } satisfies DouyinPostsResult;
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(readingPagination ? "抖音分页加载超时，未完整同步" : "等待抖音主页数据超时");
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      if (!page.isClosed()) await page.close();
    } catch {
      // Cleanup must not replace the synchronization result.
    }
  }
}

export async function openDouyinBrowserSession(signal?: AbortSignal): Promise<DouyinBrowserSession> {
  throwIfAborted(signal);
  const [executablePath, cookieHeader] = await Promise.all([
    resolveBrowserExecutable(),
    readCookieHeader(),
  ]);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  try {
    throwIfAborted(signal);
    return {
      fetchUserPosts: async (profileUrl, knownVideoIds = new Set(), requestSignal) => {
        throwIfAborted(requestSignal);
        const context = await createContext(browser, executablePath, cookieHeader);
        try {
          return await fetchUserPosts(context, profileUrl, knownVideoIds, requestSignal);
        } finally {
          try {
            await closeWithTimeout(context);
          } catch {
            // Cleanup must not replace the synchronization result.
          }
        }
      },
      close: () => closeWithTimeout(browser),
    };
  } catch (error) {
    await closeWithTimeout(browser);
    throw error;
  }
}

export type DouyinFollowingPage = {
  creators: FollowingCreator[];
  received: number;
  total: number;
  invalidCount: number;
  account?: { id: string; name: string };
};

/** Read the authenticated user's following pages through the same browser session used for feed sync. */
export async function collectDouyinFollowing(
  onPage: (page: DouyinFollowingPage) => Promise<void> | void,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const [executablePath, cookieHeader] = await Promise.all([resolveBrowserExecutable(), readCookieHeader()]);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  });
  const context = await createContext(browser, executablePath, cookieHeader);
  const page = await context.newPage();
  const onAbort = () => { void page.close().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    const selfResponsePromise = page.waitForResponse((response) => {
      try { return new URL(response.url()).pathname === "/aweme/v1/web/user/profile/self/"; } catch { return false; }
    }, { timeout: PAGE_TIMEOUT_MS });
    selfResponsePromise.catch(() => undefined);
    await page.goto("https://www.douyin.com/user/self", { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    const self = asRecord(await (await selfResponsePromise).json());
    const selfUser = asRecord(self.user);
    if (Number(self.status_code) !== 0 || !validFollowingId("douyin", String(selfUser.sec_uid ?? ""))) {
      throw new Error("抖音登录状态无效，请更新 Cookie 后重试");
    }
    await onPage({
      creators: [], received: 0, total: Number(selfUser.following_count) || 0, invalidCount: 0,
      account: { id: String(selfUser.sec_uid), name: cleanFollowingName(selfUser.nickname, "douyin") },
    });

    const seenIds = new Set<string>();
    const seenPages = new Set<string>();
    let expectedTotal: number | undefined;
    let received = 0;
    let invalidCount = 0;
    let lastOffset = -1;
    let requestedResponse: Promise<Response> | null = null;

    const getFollowingResponse = async (response: Response) => {
      const payload = asRecord(await response.json());
      if (Number(payload.status_code) !== 0 || !Array.isArray(payload.followings)) {
        throw new Error("抖音关注接口返回了不可识别的数据，可能需要重新登录或完成验证");
      }
      const items = payload.followings as unknown[];
      const total = Number(payload.total);
      const offset = Number(payload.offset);
      if (!Number.isSafeInteger(total) || total < 0 || total > FOLLOWING_LIMIT) throw new Error("抖音关注总数异常，未完整提取");
      if (!Number.isSafeInteger(offset) || offset <= lastOffset) throw new Error("抖音关注分页游标重复或倒退，未完整提取");
      lastOffset = offset;
      if (expectedTotal !== undefined && expectedTotal !== total) throw new Error("抖音关注总数在提取过程中发生变化");
      expectedTotal = total;
      const signature = items.map((item) => String(asRecord(item).sec_uid ?? asRecord(item).uid ?? "")).join("|");
      if (seenPages.has(signature)) throw new Error("抖音关注分页重复，未能确认已读取全部名单");
      seenPages.add(signature);
      const creators: FollowingCreator[] = [];
      for (const value of items) {
        const item = asRecord(value);
        const id = String(item.sec_uid ?? "");
        if (!validFollowingId("douyin", id)) { invalidCount += 1; continue; }
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        creators.push({
          platform: "douyin", platformUserId: id,
          name: cleanFollowingName(item.nickname, "douyin"),
          profileUrl: followingProfileUrl("douyin", id),
          ...(followingAvatar(item.avatar_thumb ?? item.avatar_medium ?? item.avatar_larger) ? { avatarUrl: followingAvatar(item.avatar_thumb ?? item.avatar_medium ?? item.avatar_larger) } : {}),
        });
      }
      received = seenIds.size;
      await onPage({ creators, received, total, invalidCount });
      return { hasMore: payload.has_more === true || Number(payload.has_more) === 1, itemCount: items.length };
    };

    const followingPath = "/aweme/v1/web/user/following/list/";
    const waitFollowingResponse = (expectedOffset: number) => page.waitForResponse((response) => {
      try {
        const url = new URL(response.url());
        const offset = Number(url.searchParams.get("offset"));
        // The request uses the previous response's body offset as its query offset.
        // Match it exactly so a fast scroll cannot skip an intermediate page.
        return url.pathname === followingPath && Number.isSafeInteger(offset) && offset === expectedOffset;
      } catch { return false; }
    }, { timeout: PAGE_TIMEOUT_MS });
    requestedResponse = waitFollowingResponse(0);
    requestedResponse.catch(() => undefined);
    // The outer summary card only expands on the text control; clicking the card
    // itself can leave the page unchanged in current Douyin builds.
    const followButton = page.locator('[data-e2e="user-info-follow"]').getByText("关注", { exact: true });
    if (await followButton.count() !== 1) throw new Error("抖音关注列表入口未找到，页面结构可能已变化");
    await followButton.click();
    let next = await getFollowingResponse(await requestedResponse);
    let pages = 1;
    while (next.hasMore) {
      throwIfAborted(signal);
      if (pages >= 1000 || received >= FOLLOWING_LIMIT) throw new Error("抖音关注列表超过安全上限，未完整提取");
      requestedResponse = waitFollowingResponse(lastOffset);
      requestedResponse.catch(() => undefined);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 1500);
        if (!signal) return;
        const abort = () => { clearTimeout(timeout); reject(createAbortError()); };
        signal.addEventListener("abort", abort, { once: true });
      });
      const scrollableCount = await page.evaluate(() => {
        const elements = [...document.querySelectorAll<HTMLElement>("div")]
          .filter((element) => element.clientHeight > 80
            && element.scrollHeight > element.clientHeight + 40
            && ["auto", "scroll"].includes(getComputedStyle(element).overflowY));
        elements.forEach((element) => { element.scrollTop = element.scrollHeight; });
        return elements.length;
      });
      if (!scrollableCount) throw new Error("抖音关注列表滚动容器未找到，未完整提取");
      next = await getFollowingResponse(await requestedResponse);
      pages += 1;
      if (next.itemCount === 0 && next.hasMore) throw new Error("抖音关注分页提前返回空页，未完整提取");
    }
    if (expectedTotal !== undefined && received !== expectedTotal) throw new Error("抖音关注数量与平台总数不一致，未完整提取");
    return { received, total: expectedTotal ?? received, invalidCount };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await closeWithTimeout(context);
    await closeWithTimeout(browser);
  }
}
