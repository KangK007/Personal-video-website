// Verify platform links against a real Chromium extension installation.
// FocusExtension is intentionally supplied by the caller so this check also
// works when the plugin is kept outside the project checkout.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.argv[2] ?? process.env.E2E_BASE_URL ?? "http://127.0.0.1:3131";
const EXTENSION_PATH = process.env.FOCUS_EXTENSION_PATH ?? "D:\\浏览器插件\\FocusExtension";
const PROFILE_DIR = path.join(process.cwd(), ".local", "e2e", "focus-extension-profile");

function browserExecutable() {
  const candidates = [
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("No Edge/Chrome executable found");
  return executable;
}

function check(name, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${condition || !detail ? "" : ` -- ${detail}`}`);
  return Boolean(condition);
}

function seedState(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("just-follow-feed", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("state")) request.result.createObjectStore("state");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const now = new Date().toISOString();
      const transaction = request.result.transaction("state", "readwrite");
      transaction.objectStore("state").put({
        version: 2,
        revision: 1,
        creators: [
          { id: "extension-smoke-bilibili", platform: "bilibili", profileUrl: "https://space.bilibili.com/123456", name: "哔站联动测试", nameSource: "manual", enabled: true },
          { id: "extension-smoke-douyin", platform: "douyin", profileUrl: "https://www.douyin.com/user/MS4wLjABAAAAtest", name: "抖音联动测试", nameSource: "manual", enabled: true },
        ],
        videos: [
          { id: "extension-smoke-bilibili-video", platform: "bilibili", videoUrl: "https://www.bilibili.com/video/BV1test0001", creatorId: "extension-smoke-bilibili", title: "哔站联动测试视频", publishedAt: now, source: "manual", createdAt: now },
          { id: "extension-smoke-douyin-video", platform: "douyin", videoUrl: "https://www.douyin.com/video/7638639979597450542", creatorId: "extension-smoke-douyin", title: "抖音联动测试视频", publishedAt: now, source: "manual", createdAt: now },
        ],
      }, "feed");
      transaction.oncomplete = () => {
        request.result.close();
        resolve(undefined);
      };
      transaction.onerror = () => reject(transaction.error);
    };
  }));
}

const failures = [];
if (!fs.existsSync(EXTENSION_PATH)) throw new Error(`FocusExtension path does not exist: ${EXTENSION_PATH}`);
fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: browserExecutable(),
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
});

const page = context.pages()[0] ?? (await context.newPage());
// The extension smoke must stay hermetic: the session preflight and the sync route
// are both stubbed so a reload never launches a browser or reads the real cookie.
await context.route("**/api/bilibili/session", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ status: "logged-in" }),
}));
await context.route("**/api/feed/sync", async (route) => {
  const creators = JSON.parse(route.request().postData() ?? "{}").creators ?? [];
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      configured: true,
      syncedAt: new Date().toISOString(),
      videos: [],
      results: creators.map((creator) => ({ creatorId: creator.id, status: "success", count: 0, complete: true, mode: "incremental" })),
    }),
  });
});

async function clickAndRead(locator, label, expectedHost, nextVideoUrl) {
  const popup = context.waitForEvent("page", { timeout: 15_000 });
  await locator.click();
  const target = await popup;
  const navigations = [target.url()];
  target.on("framenavigated", (frame) => {
    if (frame === target.mainFrame()) navigations.push(frame.url());
  });
  await target.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
  await target.waitForTimeout(1500);
  const url = target.url();
  const ok = new URL(url).hostname === expectedHost && page.url().startsWith(BASE_URL);
  if (!check(`${label}未被重定向到插件面板`, ok, navigations.join(" -> "))) failures.push(`${label}: ${url}`);
  if (ok && nextVideoUrl) {
    await target.evaluate((nextUrl) => window.location.assign(nextUrl), nextVideoUrl);
    await target.waitForURL((nextUrl) => nextUrl.protocol === "chrome-extension:", { timeout: 10_000 }).catch(() => undefined);
    const blockedUrl = target.url();
    const blocked = blockedUrl.startsWith("chrome-extension://") && blockedUrl.includes("dashboard.html");
    if (!check("离开抖音首屏后的另一个视频仍被拦截", blocked, blockedUrl)) failures.push(`next video: ${blockedUrl}`);
  }
  await target.close().catch(() => undefined);
}

try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  if (!check("已加载真实 FocusExtension 服务", worker.url().endsWith("/background.js"), worker.url())) {
    failures.push("FocusExtension service worker not loaded");
  }
  const control = await context.newPage();
  await control.goto("https://www.bilibili.com/video/BV1test0001", { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => undefined);
  const blockedUrl = control.url();
  if (!check("无本站来源的导航仍被插件拦截", blockedUrl.startsWith("chrome-extension://") && blockedUrl.includes("dashboard.html"), blockedUrl)) {
    failures.push(`extension control: ${blockedUrl}`);
  }
  await control.close();

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await seedState(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".video-card").first().waitFor({ timeout: 15_000 });
  for (const [platform, host] of [["bilibili", "www.bilibili.com"], ["douyin", "www.douyin.com"]]) {
    await clickAndRead(
      page.locator(`.video-card.platform-${platform}`).first().locator("a.cover-wrap"),
      `${platform} 视频入口`,
      host,
      platform === "douyin" ? "https://www.douyin.com/video/7533565207131131196" : undefined,
    );
  }

  await page.locator('.main-nav a[href="/following"]').click();
  await page.locator(".creator-list-card").first().waitFor({ timeout: 10_000 });
  for (const [platform, host] of [["bilibili", "space.bilibili.com"], ["douyin", "www.douyin.com"]]) {
    const card = page.locator(`.creator-list-card:has(.platform-dot.platform-${platform})`);
    await clickAndRead(card.locator(".creator-list-actions a"), `${platform} 关注列表原主页入口`, host);
    await card.locator(".creator-list-main").click();
    await page.locator(".creator-profile-header").waitFor({ timeout: 10_000 });
    await clickAndRead(page.locator(".creator-profile-actions a"), `${platform} 个人页原主页入口`, host);
    await page.locator('.main-nav a[href="/following"]').click();
  }
} finally {
  await context.close().catch(() => undefined);
}

if (failures.length) {
  console.error(`\n${failures.length} FocusExtension link checks failed`);
  process.exit(1);
}
console.log("\n9/9 FocusExtension link checks passed");
