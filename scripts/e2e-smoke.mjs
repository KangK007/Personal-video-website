// End-to-end smoke suite for 只看关注.
//
// Runs a real headless Edge/Chrome against a running production build and walks the
// main user journeys. External platform services are stubbed at the network layer
// (/api/feed/sync and /api/metadata), so this verifies app behaviour, not platform
// availability. Start a server first, then run:
//   npx next start --hostname 127.0.0.1 --port 3100
//   node scripts/e2e-smoke.mjs            # or: npm run test:e2e
//   node scripts/e2e-smoke.mjs http://127.0.0.1:3100
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.argv[2] ?? process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";
const SHOT_DIR = path.join(process.cwd(), ".local", "e2e", "shots");

const results = [];
let failures = 0;

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures += 1;
  const mark = condition ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${condition || !detail ? "" : ` -- ${detail}`}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function browserExecutable() {
  const candidates = [
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("No Edge/Chrome executable found");
}

const STATUS_SETTLED = /本地保存|已同步|部分完成|同步失败|保存失败/;

async function statusText(page) {
  return (await page.locator(".topbar-status").first().innerText()).trim();
}

async function waitSettled(page) {
  await page.waitForFunction((pattern) => {
    const node = document.querySelector(".topbar-status");
    return node ? new RegExp(pattern).test(node.textContent ?? "") : false;
  }, STATUS_SETTLED.source, { timeout: 30_000 });
}

async function readStoredState(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("just-follow-feed", 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("state", "readonly");
      const get = tx.objectStore("state").get("feed");
      get.onsuccess = () => {
        const value = get.result ?? null;
        db.close();
        resolve(value);
      };
      get.onerror = () => reject(get.error);
    };
  }));
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: false });
}

/** Deterministic sync stub: answers each batch with one video per creator. */
function installSyncStub(context, state) {
  return context.route("**/api/feed/sync", async (route) => {
    let body = {};
    try {
      body = JSON.parse(route.request().postData() ?? "{}");
    } catch {
      body = {};
    }
    const creators = Array.isArray(body.creators) ? body.creators : [];
    state.syncCalls.push(creators.map((creator) => creator.id));
    if (state.syncDelayMs) await new Promise((resolve) => setTimeout(resolve, state.syncDelayMs));
    if (state.syncMode === "fail") {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "同步服务暂时不可用" }),
      });
      return;
    }
    if (state.syncErrorMessage) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          configured: state.syncConfigured,
          syncedAt: new Date().toISOString(),
          videos: [],
          results: creators.map((creator) => ({
            creatorId: creator.id,
            status: "error",
            count: 0,
            complete: false,
            mode: "snapshot",
            message: state.syncErrorMessage,
          })),
        }),
      });
      return;
    }
    const videos = [];
    const syncResults = [];
    const now = Date.now();
    for (const [index, creator] of creators.entries()) {
      const isDouyin = creator.platform === "douyin";
      const seed = state.videoSeed;
      state.videoSeed += 1;
      const platformId = isDouyin
        ? String(7201234567890123450 + seed)
        : `BV1${String(seed).padStart(9, "a")}`;
      const videoUrl = isDouyin
        ? `https://www.douyin.com/video/${platformId}`
        : `https://www.bilibili.com/video/${platformId}`;
      videos.push({
        id: `sync-${creator.platform}-${platformId}`,
        platform: creator.platform,
        videoUrl,
        creatorId: creator.id,
        title: `${creator.name} 的第 ${index + 1} 条投稿`,
        coverUrl: "https://example.invalid/cover.jpg",
        publishedAt: new Date(now - state.publishedOffsetMs - 2 * 3600_000 - index * 60_000).toISOString(),
        duration: "01:23",
        source: "feed-sync",
        createdAt: new Date(now).toISOString(),
      });
      syncResults.push({
        creatorId: creator.id,
        status: "success",
        count: 1,
        complete: true,
        mode: "snapshot",
        profile: { name: `${creator.name}（平台昵称）` },
      });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: true, syncedAt: new Date(now).toISOString(), videos, results: syncResults }),
    });
  });
}

function installMetadataStub(context, state) {
  return context.route("**/api/metadata", async (route) => {
    state.metadataCalls += 1;
    let url = "";
    try {
      url = JSON.parse(route.request().postData() ?? "{}").url ?? "";
    } catch {
      url = "";
    }
    if (state.metadataMode === "fail") {
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "页面暂时无法读取，请手动填写视频信息" }) });
      return;
    }
    if (/^https?:\/\/b23\.tv\//i.test(url) || /^https?:\/\/v\.douyin\.com\//i.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ title: "短链接解析出的视频", coverUrl: "https://example.invalid/short.jpg", description: "", url: "https://www.bilibili.com/video/BV1short0001" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ title: "手动保存的测试视频", coverUrl: "https://example.invalid/manual.jpg", description: "", url }),
    });
  });
}

const state = { syncCalls: [], syncMode: "ok", metadataCalls: 0, metadataMode: "ok", videoSeed: 0, publishedOffsetMs: 0, syncDelayMs: 0, syncConfigured: true, syncErrorMessage: "" };

const context = await chromium.launchPersistentContext(path.join(process.cwd(), ".local", "e2e", "profile"), {
  executablePath: browserExecutable(),
  headless: true,
  acceptDownloads: true,
  viewport: { width: 1440, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.on("pageerror", (error) => console.log(`  [pageerror] ${error.message}`));
installSyncStub(context, state);
installMetadataStub(context, state);

const dialogButton = (name) => page.locator(".modal").getByRole("button", { name, exact: false });
const today = new Date().toISOString().slice(0, 10);

try {
  // ---------------------------------------------------------------- first use
  section("首次使用 / 空数据");
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell", { timeout: 20_000 });
  await page.getByRole("heading", { name: "还没有关注博主" }).waitFor({ timeout: 15_000 });
  check("空数据时显示引导空态", true);
  check("侧边栏最近更新计数为 0", (await page.locator('.main-nav a[href="/"]').innerText()).includes("0"));
  await shot(page, "01-empty-home");

  // ------------------------------------------------------- add creators (batch)
  section("添加博主 / 批量导入校验");
  await page.locator("button.sidebar-action", { hasText: "添加博主" }).click();
  const creatorTextarea = page.locator("#creator-lines");
  await creatorTextarea.waitFor({ timeout: 10_000 });
  await creatorTextarea.fill("哔站测试博主 https://space.bilibili.com/123456\n无效行没有链接\nhttps://space.bilibili.com/123456");
  const dupSummary = (await page.locator(".import-summary").innerText()).replace(/\s+/g, " ");
  check("批量导入统计识别重复行", /1\s*条重复/.test(dupSummary), dupSummary);
  check("批量导入统计识别无效行", /1\s*行无效/.test(dupSummary), dupSummary);
  const submitAdd = dialogButton("确认添加");
  await submitAdd.click();
  await page.waitForTimeout(250);
  check("存在无效行时阻止提交", (await page.locator("#creator-lines").count()) === 1);

  await creatorTextarea.fill([
    "哔站测试博主 https://space.bilibili.com/123456",
    "抖音测试博主 https://www.douyin.com/user/MS4wLjABAAAAtest",
    "https://space.bilibili.com/654321",
  ].join("\n"));
  await submitAdd.click();
  await page.locator(".notice-text").filter({ hasText: "已添加 3 位博主" }).waitFor({ timeout: 10_000 });
  check("成功添加 3 位博主（含 1 位无昵称）", true);
  await waitSettled(page);
  await page.waitForTimeout(500);

  const storedAfterAdd = await readStoredState(page);
  check("IndexedDB 已持久化 3 位博主", storedAfterAdd?.creators?.length === 3, `creators=${storedAfterAdd?.creators?.length}`);

  // ------------------------------------------------------------ 自动同步
  section("自动同步（首次添加后即触发，无需刷新）");
  await page.waitForFunction(() => document.querySelectorAll(".video-card").length === 3, null, { timeout: 30_000 });
  check("添加博主后自动同步并展示 3 条视频", (await page.locator(".video-card").count()) === 3);
  const creatorNames = await page.locator(".creator-chip span").allInnerTexts();
  check("保留手动填写的博主昵称", creatorNames.includes("哔站测试博主") && creatorNames.includes("抖音测试博主"), creatorNames.join("|"));
  check("无昵称博主回填平台昵称", creatorNames.some((name) => name.includes("平台昵称")), creatorNames.join("|"));
  await shot(page, "02-home-synced");

  // --------------------------------------------------------- filters/search
  section("筛选 / 搜索 / 视图");
  await page.locator(".platform-tabs button", { hasText: "哔站" }).click();
  await page.waitForTimeout(200);
  check("平台筛选只保留哔站视频", (await page.locator(".video-card").count()) === 2, `cards=${await page.locator(".video-card").count()}`);
  await page.locator(".platform-tabs button", { hasText: "全部" }).click();
  await page.waitForTimeout(200);

  const search = page.locator('.search-box input[type="search"]').first();
  await search.fill("抖音测试博主");
  await page.waitForTimeout(250);
  check("搜索按标题/博主过滤", (await page.locator(".video-card").count()) === 1, `cards=${await page.locator(".video-card").count()}`);
  await search.fill("不存在的关键词");
  await page.waitForTimeout(250);
  await page.getByRole("heading", { name: "没有匹配结果" }).waitFor({ timeout: 5000 });
  check("无结果时显示空态", true);
  await page.locator(".empty-state button", { hasText: "清除筛选" }).click();
  await page.waitForTimeout(250);
  check("清除筛选后恢复列表", (await page.locator(".video-card").count()) === 3);

  await page.locator(".view-toggle button").nth(1).click();
  await page.waitForTimeout(200);
  check("切换列表视图", (await page.locator(".video-grid.is-list").count()) === 1);
  await page.locator(".view-toggle button").nth(0).click();
  await page.waitForTimeout(200);

  // ----------------------------------------------------------- 手动保存视频
  section("手动保存视频 / 元数据");
  await page.locator("button.sidebar-action", { hasText: "保存一个视频" }).click();
  const urlInput = page.locator("#video-url");
  await urlInput.waitFor({ timeout: 10_000 });
  await urlInput.fill("https://www.bilibili.com/video/BV1manual0001");
  await page.getByRole("button", { name: "读取信息" }).click();
  await page.waitForFunction(() => (document.querySelector("#video-title")?.value ?? "") === "手动保存的测试视频", null, { timeout: 10_000 });
  check("读取公开元数据回填标题", true);
  await page.locator("#video-title").fill("手动保存的测试视频");
  await page.locator("#video-date").fill(today);
  await dialogButton("保存视频").click();
  await page.locator(".notice-text").filter({ hasText: "视频已保存" }).waitFor({ timeout: 10_000 });
  check("手动视频保存成功", true);
  await waitSettled(page);
  await page.waitForTimeout(400);

  const manualStored = await readStoredState(page);
  const manualVideo = manualStored?.videos?.find((video) => video.source === "manual");
  check("手动视频写入 IndexedDB", Boolean(manualVideo), `videos=${manualStored?.videos?.length}`);
  check("手动视频进入最近更新列表", (await page.locator(".video-card").count()) === 4, `cards=${await page.locator(".video-card").count()}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell");
  await waitSettled(page);
  await page.waitForTimeout(400);
  check("刷新后手动视频仍在本地", (await page.locator(".video-card").count()) === 4, `cards=${await page.locator(".video-card").count()}`);
  check("刷新后博主仍在关注列表", (await page.locator('.main-nav a[href="/following"]').innerText()).includes("3"));

  // --------------------------------------------------------- 重复保存与校验
  section("重复提交 / 无效输入");
  await page.locator("button.sidebar-action", { hasText: "保存一个视频" }).click();
  await urlInput.waitFor({ timeout: 10_000 });
  await urlInput.fill("https://www.bilibili.com/video/BV1manual0001");
  await page.locator("#video-title").fill("重复视频");
  await dialogButton("保存视频").click();
  await page.locator(".notice-text").filter({ hasText: "已经在本地保存" }).waitFor({ timeout: 10_000 });
  check("重复视频被去重并提示", true);
  await dialogButton("取消").click();

  await page.locator("button.sidebar-action", { hasText: "保存一个视频" }).click();
  await urlInput.waitFor({ timeout: 10_000 });
  await urlInput.fill("https://example.com/not-a-platform-video");
  await page.locator("#video-title").fill("平台不符");
  await dialogButton("保存视频").click();
  await page.waitForTimeout(300);
  const urlError = await page.locator(".video-modal .field-error").first().innerText();
  check("非平台链接被拒绝并给出字段错误", urlError.includes("抖音") || urlError.includes("链接"), urlError);
  await dialogButton("取消").click();

  await page.locator("button.sidebar-action", { hasText: "添加博主" }).click();
  const repeatTextarea = page.locator("#creator-lines");
  await repeatTextarea.waitFor({ timeout: 10_000 });
  await repeatTextarea.fill("https://space.bilibili.com/123456");
  await dialogButton("确认添加").click();
  await page.waitForTimeout(300);
  const repeatError = await page.locator(".creator-modal .field-error").first().innerText();
  check("重复添加同一博主被阻止", repeatError.includes("新博主") || repeatError.includes("重复"), repeatError);
  await dialogButton("取消").click();

  // ------------------------------------------------------------ 关注列表操作
  section("关注列表：筛选 / 暂停 / 重试");
  await page.locator('.main-nav a[href="/following"]').click();
  await page.waitForSelector(".creator-list-card", { timeout: 10_000 });
  check("关注列表显示 3 位博主", (await page.locator(".creator-list-card").count()) === 3);

  await page.locator(".status-tabs button", { hasText: "全部" }).click();
  await page.locator(".platform-tabs button", { hasText: "抖音" }).click();
  await page.waitForTimeout(250);
  check("关注列表平台筛选生效", (await page.locator(".creator-list-card").count()) === 1, `cards=${await page.locator(".creator-list-card").count()}`);
  await page.locator(".platform-tabs button", { hasText: "全部" }).click();
  await page.waitForTimeout(250);

  const firstCard = page.locator(".creator-list-card").first();
  await firstCard.getByRole("button", { name: "暂停" }).click();
  await page.waitForTimeout(400);
  check("暂停后卡片标记为已暂停", (await firstCard.locator(".status-badge.is-paused").count()) === 1);
  await page.locator(".status-tabs button", { hasText: "已暂停" }).click();
  await page.waitForTimeout(300);
  check("已暂停筛选只显示暂停博主", (await page.locator(".creator-list-card").count()) === 1, `cards=${await page.locator(".creator-list-card").count()}`);
  await page.locator(".status-tabs button", { hasText: "全部" }).click();
  await page.waitForTimeout(300);

  await firstCard.getByRole("button", { name: "恢复" }).click();
  await page.waitForTimeout(400);
  check("恢复后可再次同步", (await firstCard.getByRole("button", { name: "暂停" }).count()) === 1);

  const beforeSync = state.syncCalls.length;
  await firstCard.getByRole("button", { name: "重试" }).click();
  await page.waitForTimeout(900);
  check("单博主重试触发同步请求", state.syncCalls.length > beforeSync, `before=${beforeSync} after=${state.syncCalls.length}`);
  await waitSettled(page);

  // -------------------------------------------------- 取消关注与 10 秒撤销
  section("取消关注与撤销");
  const beforeUnfollow = await readStoredState(page);
  const victim = await firstCard.locator("strong").first().innerText();
  const victimVideos = beforeUnfollow.videos.filter((video) => video.creatorId === beforeUnfollow.creators.find((creator) => creator.name === victim.trim())?.id).length;
  await firstCard.locator('button[aria-label^="取消关注"]').click();
  await page.getByRole("button", { name: "确认取消关注" }).click();
  await page.locator(".notice-text").filter({ hasText: "已取消关注" }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  check("取消关注后从列表移除", (await page.locator(".creator-list-card").count()) === 2, `cards=${await page.locator(".creator-list-card").count()}`);
  const afterUnfollow = await readStoredState(page);
  check("取消关注同时删除该博主的本地视频", afterUnfollow.videos.length === beforeUnfollow.videos.length - victimVideos,
    `before=${beforeUnfollow.videos.length} after=${afterUnfollow.videos.length} removed=${victimVideos}`);

  await page.locator(".notice-action", { hasText: "撤销" }).click();
  await page.waitForTimeout(600);
  await waitSettled(page);
  check("10 秒内撤销恢复博主", (await page.locator(".creator-list-card").count()) === 3, `cards=${await page.locator(".creator-list-card").count()}`);
  const restoredStored = await readStoredState(page);
  check("撤销后本地视频一并恢复", restoredStored.videos.length === beforeUnfollow.videos.length,
    `videos=${restoredStored.videos.length} expected=${beforeUnfollow.videos.length}`);

  // ------------------------------------------------------------- 删除与撤销
  section("视频删除与撤销");
  await page.locator('.main-nav a[href="/"]').click();
  await page.waitForSelector(".video-card", { timeout: 10_000 });
  await waitSettled(page);
  await page.waitForTimeout(300);
  const deleteButton = page.locator(".card-delete").first();
  if (await deleteButton.count()) {
    const beforeDelete = await page.locator(".video-card").count();
    await deleteButton.click();
    await page.locator(".notice-text").filter({ hasText: "已移除本地保存的视频" }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
    check("删除后卡片数量减少", (await page.locator(".video-card").count()) === beforeDelete - 1, `cards=${await page.locator(".video-card").count()}`);
    await page.locator(".notice-action", { hasText: "撤销" }).click();
    await page.waitForTimeout(500);
    check("撤销删除恢复卡片", (await page.locator(".video-card").count()) === beforeDelete, `cards=${await page.locator(".video-card").count()}`);
  } else {
    check("可删除视频显示删除按钮", false, "no .card-delete found");
  }

  // ------------------------------------------------------------ 同步失败恢复
  section("同步失败与重试");
  state.syncMode = "fail";
  await page.locator(".topbar-actions button", { hasText: "同步关注流" }).click();
  await page.waitForFunction(() => /同步失败|部分完成/.test(document.querySelector(".topbar-status")?.textContent ?? ""), null, { timeout: 40_000 });
  check("同步失败时状态可见", /同步失败|部分完成/.test(await statusText(page)), await statusText(page));
  const progressText = (await page.locator(".sync-progress").first().innerText()).replace(/\s+/g, " ");
  check("失败后提示可重试", progressText.includes("失败"), progressText);
  check("提供仅重试失败入口", (await page.locator(".sync-progress button", { hasText: "仅重试失败" }).count()) === 1);
  const cardsAfterFailure = await page.locator(".video-card").count();
  check("同步失败保留原有缓存", cardsAfterFailure === 4, `cards=${cardsAfterFailure}`);
  await shot(page, "03-sync-failed");

  state.syncMode = "ok";
  await page.locator(".sync-progress button", { hasText: "仅重试失败" }).click();
  await waitSettled(page);
  await page.waitForTimeout(600);
  check("重试后恢复成功状态", /已同步|本地保存/.test(await statusText(page)), await statusText(page));

  // -------------------------------------------------------------- 备份/清空/导入
  section("备份导出 / 清空 / 导入");
  await page.locator(".sidebar-settings").click();
  await page.getByRole("heading", { name: "数据与设置" }).waitFor({ timeout: 10_000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByRole("button", { name: "导出备份" }).click();
  const download = await downloadPromise;
  const backupPath = path.join(process.cwd(), ".local", "e2e", "backup-export.json");
  await download.saveAs(backupPath);
  const exported = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  check("导出备份包含博主与视频", exported.version === 2 && exported.creators.length === 3 && exported.videos.length === 4,
    `creators=${exported.creators.length} videos=${exported.videos.length}`);
  await dialogButton("关闭窗口").click();

  await page.locator(".sidebar-settings").click();
  await page.getByRole("button", { name: "清空本地数据" }).click();
  await page.getByRole("button", { name: "确认清空" }).click();
  await page.locator(".notice-text").filter({ hasText: "本地数据已清空" }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await waitSettled(page);
  const clearedStored = await readStoredState(page);
  check("清空后本地数据为空", (clearedStored?.creators?.length ?? 0) === 0 && (clearedStored?.videos?.length ?? 0) === 0);
  await page.getByRole("heading", { name: "还没有关注博主" }).waitFor({ timeout: 10_000 });
  check("清空后回到引导空态", true);

  await page.locator(".sidebar-settings").click();
  await page.getByRole("heading", { name: "数据与设置" }).waitFor({ timeout: 10_000 });
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("button", { name: "导入备份" }).click();
  const fileChooser = await chooser;
  await fileChooser.setFiles(backupPath);
  await page.getByRole("button", { name: "确认导入" }).click();
  await page.locator(".notice-text").filter({ hasText: "已导入" }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await waitSettled(page);
  const importedStored = await readStoredState(page);
  check("导入备份恢复全部数据", importedStored?.creators?.length === 3 && importedStored?.videos?.length === exported.videos.length,
    `creators=${importedStored?.creators?.length} videos=${importedStored?.videos?.length}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell");
  await waitSettled(page);
  await page.waitForTimeout(400);
  check("导入数据刷新后仍然存在", (await page.locator(".video-card").count()) === 4, `cards=${await page.locator(".video-card").count()}`);

  // ------------------------------------------------------------------ 个人页
  section("博主个人页");
  await page.locator('.main-nav a[href="/following"]').click();
  await page.waitForSelector(".creator-list-card");
  await page.locator(".creator-list-main").first().click();
  await page.waitForSelector(".creator-profile-header", { timeout: 10_000 });
  await waitSettled(page);
  await page.waitForTimeout(400);
  check("个人页展示该博主全部本地视频", (await page.locator(".video-card").count()) >= 1, `cards=${await page.locator(".video-card").count()}`);
  const profileHeader = (await page.locator(".creator-profile-header").innerText()).replace(/\s+/g, " ");
  check("个人页显示视频总数", /条视频/.test(profileHeader), profileHeader.slice(0, 120));
  await shot(page, "04-creator-detail");

  await page.goto(`${BASE_URL}/creator/does-not-exist`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "博主不存在或已取消关注" }).waitFor({ timeout: 10_000 });
  check("未知博主个人页显示明确的空态", true);

  // ------------------------------------------------------------------ 主题
  section("显示偏好");
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell");
  await waitSettled(page);
  await page.locator(".sidebar-settings").click();
  await page.locator(".theme-options button", { hasText: "深色" }).click();
  await page.waitForTimeout(300);
  check("切换深色主题立即生效", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await dialogButton("关闭窗口").click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell");
  await page.waitForTimeout(400);
  check("主题偏好刷新后保留", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");

  // ------------------------------------------------------------------ 移动端
  section("移动端布局");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell");
  await waitSettled(page);
  await page.waitForTimeout(600);
  check("移动端显示底部导航", await page.locator(".mobile-bottom-nav").isVisible());
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("移动端无横向溢出", overflow <= 1, `overflow=${overflow}px`);
  await shot(page, "05-mobile-home");

  await context.close();

  // ------------------------------------------------- second, isolated origin
  section("残留旧版缓存 / 分享短链接 / 空态同步按钮");
  fs.rmSync(path.join(process.cwd(), ".local", "e2e", "profile-2"), { recursive: true, force: true });
  const second = await chromium.launchPersistentContext(path.join(process.cwd(), ".local", "e2e", "profile-2"), {
    executablePath: browserExecutable(),
    headless: true,
    viewport: { width: 1440, height: 900 },
  });
  const page2 = second.pages()[0] ?? (await second.newPage());
  page2.on("pageerror", (error) => console.log(`  [pageerror] ${error.message}`));
  installSyncStub(second, state);
  installMetadataStub(second, state);
  state.videoSeed = 100;
  state.syncCalls = [];
  state.publishedOffsetMs = 0;
  state.syncDelayMs = 0;

  try {
    // A leftover half of the v1 localStorage cache with an empty IndexedDB used to
    // pin the app on the read-error screen forever.
    await second.addInitScript(() => {
      try {
        window.localStorage.setItem("just-follow-feed:creators", "[]");
      } catch {
        // Ignore opaque origins such as about:blank.
      }
    });
    await page2.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await page2.waitForSelector(".app-shell", { timeout: 20_000 });
    await page2.getByRole("heading", { name: "还没有关注博主" }).waitFor({ timeout: 15_000 });
    check("残留半份旧版缓存不再永久阻塞首次使用", true);
    check("未出现读取失败恢复页", (await page2.locator(".recovery-state").count()) === 0);

    // Batch import header tolerance + short-link saving.
    await page2.locator("button.sidebar-action", { hasText: "添加博主" }).click();
    const textarea2 = page2.locator("#creator-lines");
    await textarea2.waitFor({ timeout: 10_000 });
    await textarea2.fill("主页 https://space.bilibili.com/111111\nhttps://space.bilibili.com/777777");
    const headerSummary = (await page2.locator(".import-summary").innerText()).replace(/\s+/g, " ");
    check("带空格的表头行被跳过且不占用有效名额", /1\s*条有效/.test(headerSummary), headerSummary);
    await page2.locator(".modal").getByRole("button", { name: "确认添加" }).click();
    await page2.locator(".notice-text").filter({ hasText: "已添加 1 位博主" }).waitFor({ timeout: 10_000 });
    await waitSettled(page2);
    await page2.waitForTimeout(400);
    const headerStored = await readStoredState(page2);
    check("表头文字没有被当成博主昵称", !headerStored.creators.some((creator) => creator.name === "主页"), JSON.stringify(headerStored.creators.map((creator) => creator.name)));

    await page2.locator("button.sidebar-action", { hasText: "保存一个视频" }).click();
    const shortUrlInput = page2.locator("#video-url");
    await shortUrlInput.waitFor({ timeout: 10_000 });
    await shortUrlInput.fill("https://b23.tv/Abc_123");
    await page2.locator("#video-title").fill("分享短链接视频");
    await page2.locator("#video-date").fill(today);
    await page2.locator(".modal").getByRole("button", { name: "保存视频" }).click();
    await page2.locator(".notice-text").filter({ hasText: "视频已保存" }).waitFor({ timeout: 10_000 });
    await waitSettled(page2);
    await page2.waitForTimeout(400);
    const shortStored = await readStoredState(page2);
    const shortVideo = shortStored?.videos?.find((video) => video.title === "分享短链接视频");
    check("分享短链接在保存时自动解析为视频详情链接", shortVideo?.videoUrl === "https://www.bilibili.com/video/BV1short0001", shortVideo?.videoUrl);

    // A manual video without a publish date cannot appear in 最近更新; the notice says so.
    await page2.locator("button.sidebar-action", { hasText: "保存一个视频" }).click();
    await shortUrlInput.waitFor({ timeout: 10_000 });
    await shortUrlInput.fill("https://www.bilibili.com/video/BV1undated001");
    await page2.locator("#video-title").fill("未填发布时间的视频");
    await page2.locator(".modal").getByRole("button", { name: "保存视频" }).click();
    const undatedNotice = page2.locator(".notice-text");
    await undatedNotice.filter({ hasText: "视频已保存" }).waitFor({ timeout: 10_000 });
    check("未填发布时间的保存给出明确提示", (await undatedNotice.innerText()).includes("个人页"), await undatedNotice.innerText());
    await waitSettled(page2);
    await page2.waitForTimeout(300);
    await page2.locator('.main-nav a[href="/"]').click();
    await page2.waitForSelector(".app-shell");
    await waitSettled(page2);
    await page2.waitForTimeout(400);
    const homeTitles = await page2.locator(".video-title").allInnerTexts();
    check("未填发布时间的视频不出现在最近更新", homeTitles.length === 2 && !homeTitles.some((title) => title.includes("未填发布时间")), homeTitles.join("|"));

    // Empty-state "同步关注流" stays disabled while a sync runs and must not abort it.
    state.publishedOffsetMs = 30 * 86_400_000;
    await page2.locator(".sidebar-settings").click();
    await page2.locator(".modal").getByRole("button", { name: "清空本地数据" }).click();
    await page2.getByRole("button", { name: "确认清空" }).click();
    await page2.locator(".notice-text").filter({ hasText: "本地数据已清空" }).waitFor({ timeout: 10_000 });
    await page2.waitForTimeout(600);

    await page2.locator("button.sidebar-action", { hasText: "添加博主" }).click();
    await textarea2.waitFor({ timeout: 10_000 });
    await textarea2.fill("https://space.bilibili.com/888888");
    await page2.locator(".modal").getByRole("button", { name: "确认添加" }).click();
    await page2.locator(".notice-text").filter({ hasText: "已添加 1 位博主" }).waitFor({ timeout: 10_000 });
    await waitSettled(page2);
    await page2.waitForTimeout(600);
    await page2.getByRole("heading", { name: "最近 7 天没有更新" }).waitFor({ timeout: 15_000 });
    check("同步旧投稿后展示最近 7 天无更新空态", true);

    state.syncDelayMs = 1_500;
    const emptySync = page2.locator(".empty-state").getByRole("button", { name: /同步关注流|同步中/ });
    await emptySync.click();
    await page2.waitForTimeout(400);
    check("同步进行中空态按钮被禁用", await emptySync.isDisabled());
    await waitSettled(page2);
    await page2.waitForTimeout(500);
    const finalStatus = await statusText(page2);
    check("空态重复触发不会中断正在进行的同步", /已同步|本地保存/.test(finalStatus), finalStatus);
    const progressLabels = await page2.locator(".sync-progress").allInnerTexts();
    check("未出现误导性的其他标签页提示", !progressLabels.join(" ").includes("另一个标签页"), progressLabels.join(" ").replace(/\s+/g, " "));
    state.syncDelayMs = 0;

    // A provider that is not configured must surface the platform's own guidance
    // instead of a generic "start the local scraper" message.
    state.syncConfigured = false;
    state.syncErrorMessage = "未配置抖音 Cookie，请重新运行本机抓取服务配置脚本";
    await page2.locator(".topbar-actions button", { hasText: "同步关注流" }).click();
    await page2.waitForFunction(() => /同步失败|部分完成/.test(document.querySelector(".topbar-status")?.textContent ?? ""), null, { timeout: 30_000 });
    await page2.waitForTimeout(500);
    await page2.locator('.main-nav a[href="/following"]').click();
    await page2.waitForSelector(".creator-list-card", { timeout: 10_000 });
    const cardText = (await page2.locator(".creator-list-card").first().innerText()).replace(/\s+/g, " ");
    check("未配置的平台保留各自的准确提示", cardText.includes("抖音 Cookie"), cardText);
    check("不再错误地提示启动抓取服务", !cardText.includes("未配置本机同步服务"), cardText);
    state.syncConfigured = true;
    state.syncErrorMessage = "";
    await shot(page2, "06-empty-sync");
  } finally {
    await second.close();
  }
} catch (error) {
  console.log("\n--- diagnostics ---");
  try {
    console.log("status:", await statusText(page));
    console.log("notice:", JSON.stringify(await page.locator(".notice-text").allInnerTexts()));
    console.log("sync-progress:", JSON.stringify(await page.locator(".sync-progress").allInnerTexts()));
    console.log("main:", (await page.locator("main").innerText()).slice(0, 600).replace(/\n+/g, " | "));
    const stored = await readStoredState(page);
    console.log("stored creators:", stored?.creators?.length, "videos:", stored?.videos?.length);
  } catch (inner) {
    console.log("diagnostics failed:", inner.message);
  }
  throw error;
} finally {
  await context.close().catch(() => undefined);
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
if (failures) {
  console.log("FAILED:");
  for (const item of results.filter((entry) => !entry.ok)) console.log(` - ${item.name}${item.detail ? ` (${item.detail})` : ""}`);
}
process.exit(failures ? 1 : 0);
