import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import {
  cleanFollowingName,
  followingAvatar,
  followingProfileUrl,
  FOLLOWING_LIMIT,
  validFollowingId,
  type FollowingCreator,
} from "@/lib/following-list";
import { createContext, resolveBrowserExecutable } from "@/lib/douyin-browser";

const PAGE_TIMEOUT_MS = 30_000;
const MAX_COOKIE_BYTES = 64 * 1024;
const PAGE_SIZE = 50;
const MAX_PAGES = 1_000;
const PAGE_DELAY_MS = 1_500;
const RETRY_DELAYS_MS = [2_000, 5_000] as const;

export type BilibiliFollowingPage = {
  creators: FollowingCreator[];
  received: number;
  total: number;
  invalidCount: number;
  account?: { id: string; name: string };
};

function createAbortError() {
  return typeof DOMException !== "undefined"
    ? new DOMException("提取已取消", "AbortError")
    : Object.assign(new Error("提取已取消"), { name: "AbortError" });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function waitForMs(delay: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    if (!signal) return;
    const abort = () => { clearTimeout(timer); reject(createAbortError()); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readCookieHeader() {
  const configured = process.env.BILIBILI_COOKIE_FILE?.trim() || ".local/bilibili-cookie.txt";
  const filename = path.isAbsolute(configured)
    ? configured
    : path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  const stat = await fs.stat(filename).catch(() => null);
  if (!stat?.isFile() || stat.size === 0 || stat.size > MAX_COOKIE_BYTES) {
    throw new Error("未配置哔站 Cookie，请重新运行本机抓取服务配置脚本");
  }
  const cookie = (await fs.readFile(filename, "utf8")).trim();
  if (!cookie || /[\r\n]/.test(cookie)) throw new Error("哔站 Cookie 文件格式不正确");
  return cookie;
}

function isRetryable(error: unknown) {
  return error instanceof Error
    && error.name !== "AbortError"
    && (/超时|网络|连接|暂时不可用|接口返回 5\d\d|429/.test(error.message));
}

async function requestJson(page: Page, url: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const result = await page.evaluate(async (requestUrl) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(requestUrl, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const text = await response.text();
      if (text.length > 4 * 1024 * 1024) return { status: response.status, error: "response-too-large" };
      try {
        return { status: response.status, payload: JSON.parse(text) as unknown };
      } catch {
        return { status: response.status, error: "invalid-json" };
      }
    } catch (error) {
      return { status: 0, error: error instanceof Error ? error.name : "network-error" };
    } finally {
      window.clearTimeout(timer);
    }
  }, url);
  throwIfAborted(signal);
  if (result.status === 0 || result.error === "response-too-large") {
    throw new Error(result.error === "response-too-large" ? "哔站关注接口响应过大" : "哔站关注接口请求超时或网络中断");
  }
  if (result.status === 429) throw new Error("哔站关注接口触发限流，请稍后重试");
  if (result.status >= 500) throw new Error(`哔站接口返回 ${result.status}`);
  if (result.status < 200 || result.status >= 300 || result.error) throw new Error("哔站关注接口返回了不可识别的数据");
  return asRecord(result.payload);
}

async function requestJsonWithRetry(page: Page, url: string, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestJson(page, url, signal);
    } catch (error) {
      if (attempt >= 2 || !isRetryable(error)) throw error;
      await waitForMs(RETRY_DELAYS_MS[attempt], signal);
    }
  }
  throw new Error("哔站接口请求失败");
}

async function readNavPayload(page: Page) {
  const navResponse = page.waitForResponse((response) => {
    try {
      const url = new URL(response.url());
      return url.hostname === "api.bilibili.com" && url.pathname === "/x/web-interface/nav";
    } catch { return false; }
  }, { timeout: PAGE_TIMEOUT_MS });
  navResponse.catch(() => undefined);
  await page.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
  return asRecord(await (await navResponse).json());
}

export type BilibiliSessionState = {
  status: "logged-in" | "logged-out" | "unavailable";
  accountName?: string;
  message?: string;
};

/**
 * Lightweight login probe used before a post sync: the saved Cookie is the only
 * credential the sidecar sends, and an expired one turns into a long series of
 * risk-control failures instead of an actionable message.
 */
export async function checkBilibiliLogin(signal?: AbortSignal): Promise<BilibiliSessionState> {
  throwIfAborted(signal);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Page | undefined;
  const onAbort = () => { void page?.close().catch(() => undefined); };
  try {
    const [executablePath, cookieHeader] = await Promise.all([resolveBrowserExecutable(), readCookieHeader()]);
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
    });
    const context = await createContext(browser, executablePath, cookieHeader, ".bilibili.com");
    page = await context.newPage();
    signal?.addEventListener("abort", onAbort, { once: true });
    throwIfAborted(signal);
    const nav = await readNavPayload(page);
    const navData = asRecord(nav.data);
    if (Number(nav.code) === 0 && navData.isLogin === true) {
      return { status: "logged-in", ...(navData.uname ? { accountName: String(navData.uname) } : {}) };
    }
    return { status: "logged-out", message: "哔站 Cookie 已失效或未登录，请重新更新 Cookie" };
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : "无法检查哔站登录状态",
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

export async function collectBilibiliFollowing(
  onPage: (page: BilibiliFollowingPage) => Promise<void> | void,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const [executablePath, cookieHeader] = await Promise.all([resolveBrowserExecutable(), readCookieHeader()]);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  });
  let context: Awaited<ReturnType<typeof createContext>> | undefined;
  let page: Page | undefined;
  const onAbort = () => { void page?.close().catch(() => undefined); };
  try {
    context = await createContext(browser, executablePath, cookieHeader, ".bilibili.com");
    page = await context.newPage();
    signal?.addEventListener("abort", onAbort, { once: true });
    throwIfAborted(signal);
    const nav = await readNavPayload(page);
    const navData = asRecord(nav.data);
    if (Number(nav.code) !== 0 || navData.isLogin !== true) {
      throw new Error("哔站登录状态无效，请更新 Cookie 后重试");
    }
    const uid = String(navData.mid ?? "");
    if (!validFollowingId("bilibili", uid)) throw new Error("哔站登录账号 UID 无效");
    await onPage({
      creators: [], received: 0, total: 0, invalidCount: 0,
      account: { id: uid, name: cleanFollowingName(navData.uname, "bilibili") },
    });

    await page.goto(`https://space.bilibili.com/${uid}/relation/following`, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    throwIfAborted(signal);

    const seenIds = new Set<string>();
    const seenPages = new Set<string>();
    let expectedTotal: number | undefined;
    let invalidCount = 0;
    let received = 0;
    for (let pn = 1; pn <= MAX_PAGES; pn += 1) {
      throwIfAborted(signal);
      const url = new URL("https://api.bilibili.com/x/relation/followings");
      url.search = new URLSearchParams({
        vmid: uid,
        pn: String(pn),
        ps: String(PAGE_SIZE),
        order: "desc",
        order_type: "attention",
        web_location: "333.1387",
      }).toString();
      const payload = await requestJsonWithRetry(page, url.toString(), signal);
      const code = Number(payload.code);
      if (code !== 0) {
        if (code === -101) throw new Error("哔站登录状态无效，请更新 Cookie 后重试");
        if (code === -412 || code === -352) throw new Error("哔站关注接口触发风控或验证码，请在浏览器完成验证后重试");
        if (code === -400 || code === -403) throw new Error("哔站关注接口拒绝访问，请检查登录状态或权限");
        throw new Error(`哔站关注接口返回 ${String(payload.message ?? code)}`);
      }
      const data = asRecord(payload.data);
      const list = Array.isArray(data.list) ? data.list : null;
      const total = Number(data.total);
      if (!list || !Number.isSafeInteger(total) || total < 0 || total > FOLLOWING_LIMIT) {
        throw new Error("哔站关注分页数据不完整，未完整提取");
      }
      if (expectedTotal !== undefined && expectedTotal !== total) throw new Error("哔站关注总数在提取过程中发生变化");
      expectedTotal = total;
      const signature = list.map((item) => String(asRecord(item).mid ?? "")).join("|");
      if (seenPages.has(signature)) throw new Error("哔站关注分页重复，未能确认已读取全部名单");
      seenPages.add(signature);
      const creators: FollowingCreator[] = [];
      for (const value of list) {
        const item = asRecord(value);
        const id = String(item.mid ?? "");
        if (!validFollowingId("bilibili", id)) { invalidCount += 1; continue; }
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const avatarUrl = followingAvatar(item.face);
        creators.push({
          platform: "bilibili",
          platformUserId: id,
          name: cleanFollowingName(item.uname, "bilibili"),
          profileUrl: followingProfileUrl("bilibili", id),
          ...(avatarUrl ? { avatarUrl } : {}),
        });
      }
      const previousReceived = received;
      received = seenIds.size;
      await onPage({ creators, received, total, invalidCount });
      if (received >= total) break;
      if (!list.length || received === previousReceived) throw new Error("哔站关注分页未返回新记录，未完整提取");
      await waitForMs(PAGE_DELAY_MS, signal);
    }
    if (expectedTotal === undefined || received !== expectedTotal || invalidCount) throw new Error("哔站关注数量或账号 ID 不完整，未完整提取");
    return { received, total: expectedTotal, invalidCount };
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("哔站页面或接口请求超时，未完整提取");
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
