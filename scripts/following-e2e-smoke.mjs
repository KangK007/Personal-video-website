import { chromium } from "playwright-core";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3000";
const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
});

try {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const syncBatches = [];
    await page.route("**/api/bilibili/session", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ status: "logged-in" }),
    }));
    await page.route("**/api/feed/sync", (route) => {
      const batch = route.request().postDataJSON().creators;
      syncBatches.push(batch.map((creator) => creator.profileUrl));
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          configured: true,
          syncedAt: new Date().toISOString(),
          videos: [],
          results: batch.map((creator) => ({ creatorId: creator.id, status: "success", count: 0, complete: true, mode: "snapshot" })),
        }),
      });
    });
    const creators = ["101", "102"].map((id) => ({
      platform: "bilibili", platformUserId: id, name: `博主 ${id}`,
      profileUrl: `https://space.bilibili.com/${id}`,
    }));
    const lines = [
      { type: "account", platform: "bilibili", account: { id: "1", name: "测试账号" } },
      { type: "page", platform: "bilibili", creators, received: 2, total: 2, invalidCount: 0 },
      { type: "result", result: { platform: "bilibili", status: "complete", received: 2, total: 2, invalidCount: 0 } },
      { type: "done" },
    ];
    await page.route("**/api/following/collect", (route) => route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    }));
    await page.goto(`${baseUrl}/following`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "从平台提取" }).click();
    await page.getByRole("button", { name: "开始提取" }).click();
    await page.getByText("提取完成，请检查并选择要追加的博主").waitFor();
    const checked = await page.locator(".collector-row input:checked").count();
    if (checked !== 2) throw new Error(`完整名单应默认选中 2 位，实际选中 ${checked} 位`);
    await page.getByRole("button", { name: "追加到本站" }).click();
    await page.locator(".creator-list-card").first().waitFor();
    const added = await page.locator(".creator-list-card").count();
    if (added !== 2) throw new Error(`应追加 2 位博主，实际追加 ${added} 位`);
    await page.waitForFunction(() => document.querySelector(".topbar-status")?.textContent?.includes("已同步"));
    // Bilibili creators are paced one request at a time to reduce platform risk control.
    if (syncBatches.length !== 2
      || syncBatches[0].length !== 1 || syncBatches[0][0] !== creators[0].profileUrl
      || syncBatches[1].length !== 1 || syncBatches[1][0] !== creators[1].profileUrl) {
      throw new Error(`首次追加未自动同步 2 位博主：${JSON.stringify(syncBatches)}`);
    }
    console.log("PASS  同一流块中的最后一页和完成事件默认选中并追加全部博主");

    const partialCreator = {
      platform: "bilibili", platformUserId: "103", name: "博主 103",
      profileUrl: "https://space.bilibili.com/103",
    };
    await page.unroute("**/api/following/collect");
    await page.route("**/api/following/collect", (route) => route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "page", platform: "bilibili", creators: [partialCreator], received: 1, total: 3, invalidCount: 2 })}\n`,
    }));
    await page.getByRole("button", { name: "开始提取" }).click();
    await page.locator(".collector-message").getByText(/连接提前结束，已获取的名单保留为未完整结果/).waitFor();
    if (await page.locator(".collector-row").count() !== 1) throw new Error("中断后未保留已获取的博主");
    if (await page.locator(".collector-row input:checked").count() !== 0) throw new Error("未完整结果不应默认选中");
    if (!(await page.locator(".collector-preview-header").innerText()).includes("异常 2 条")) throw new Error("中断后未保留异常记录数");
    await page.getByRole("checkbox", { name: "包含未完整结果" }).check();
    await page.locator(".collector-row input").check();
    await page.getByRole("button", { name: "开始提取" }).click();
    await page.locator(".collector-message").getByText(/连接提前结束/).waitFor();
    if (await page.getByRole("checkbox", { name: "包含未完整结果" }).isChecked()) throw new Error("新一轮提取沿用了上次的未完整结果授权");
    if (await page.locator(".collector-row input:checked").count() !== 0) throw new Error("新一轮未完整结果仍被选中");
    await page.getByRole("checkbox", { name: "包含未完整结果" }).check();
    await page.locator(".collector-row input").check();
    await page.getByRole("button", { name: "追加到本站" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".creator-list-card").length === 3);
    console.log("PASS  网络中断保留未完整名单，需主动确认后才能追加");
    await page.waitForFunction(() => document.querySelector(".topbar-status")?.textContent?.includes("已同步"));
    await page.waitForTimeout(300);
    if (syncBatches.length !== 3 || syncBatches[2][0] !== partialCreator.profileUrl) {
      throw new Error(`再次追加应只同步新博主，实际请求 ${JSON.stringify(syncBatches)}`);
    }
    console.log("PASS  再次追加只自动同步新增博主");

    const importCreators = [
      { ...creators[0], name: "不应覆盖原昵称" },
      { ...partialCreator, platformUserId: "105", profileUrl: "https://space.bilibili.com/105", name: "博主 105" },
    ];
    const importFile = {
      kind: "following-list", version: 1, exportedAt: new Date().toISOString(),
      creators: importCreators,
      platformResults: [{ platform: "bilibili", status: "complete", received: 2, total: 2, invalidCount: 0 }],
    };
    await page.locator(".following-collector input[type=file]").setInputFiles({
      name: "following-list.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(importFile)),
    });
    await page.getByText("已载入名单文件，请检查并选择要追加的博主").waitFor();
    if (await page.locator(".collector-account").count()) throw new Error("导入文件后仍显示旧平台登录账号");
    if (await page.locator(".collector-row input:checked").count() !== 1) throw new Error("导入文件应只选中新博主");
    await page.getByRole("button", { name: "追加到本站" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".creator-list-card").length === 4);
    const cards = await page.locator(".creator-list-card").allInnerTexts();
    if (!cards.some((text) => text.includes("博主 101")) || cards.some((text) => text.includes("不应覆盖原昵称"))) {
      throw new Error("重复导入覆盖了已有博主昵称");
    }
    console.log("PASS  JSON 名单导入追加新博主且保留已有昵称");

    // A single-platform partial file only fills one progress entry; retrying the other
    // platform used to crash the whole route (undefined progress).
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const partialImportFile = {
      kind: "following-list", version: 1, exportedAt: new Date().toISOString(),
      creators: [{ ...partialCreator, name: "部分博主" }],
      platformResults: [{ platform: "bilibili", status: "partial", received: 1, total: 3, invalidCount: 2 }],
    };
    await page.locator(".following-collector input[type=file]").setInputFiles({
      name: "following-list-partial.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(partialImportFile)),
    });
    await page.getByText("已载入名单文件，请检查并选择要追加的博主").waitFor();
    await page.getByRole("button", { name: "重新提取" }).first().click();
    await page.waitForTimeout(1_200);
    if (pageErrors.length) throw new Error(`单平台部分名单重新提取崩溃：${pageErrors[0]}`);
    if (!(await page.locator(".following-collector").count())) throw new Error("重新提取后提取窗口消失");
    console.log("PASS  单平台部分名单导入后重新提取不崩溃");

    await page.waitForFunction(() => document.querySelector(".topbar-status")?.textContent?.includes("已同步"));
    const syncCountBeforeBackup = syncBatches.length;
    await page.getByRole("button", { name: "关闭窗口" }).click();
    const backup = {
      version: 2,
      creators: [{ id: "restored-1", platform: "bilibili", profileUrl: "https://space.bilibili.com/999", name: "备份博主", nameSource: "manual", enabled: true }],
      videos: [],
    };
    await page.locator('input[aria-label="选择备份文件"]').setInputFiles({
      name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)),
    });
    await page.getByRole("button", { name: "确认导入" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".creator-list-card").length === 1);
    await page.waitForTimeout(400);
    if (syncBatches.length !== syncCountBeforeBackup) throw new Error("导入全站备份被误当作新增博主并自动同步");
    console.log("PASS  全站备份替换不会误触发新增博主自动同步");
  } finally {
    await context.close();
  }

  for (const source of ["www", "api", "space"]) {
    const bridgeContext = await browser.newContext();
    try {
      // Echo the caller origin so the same stub works for www / space cross-origin calls.
      const corsFor = (request) => ({
        "access-control-allow-origin": request.headers()["origin"] ?? "https://www.bilibili.com",
        "access-control-allow-credentials": "true",
      });
      await bridgeContext.route("https://www.bilibili.com/", (route) => route.fulfill({
        contentType: "text/html", body: "<!doctype html><title>哔哩哔哩</title>",
      }));
      await bridgeContext.route("https://space.bilibili.com/**", (route) => route.fulfill({
        contentType: "text/html", body: "<!doctype html><title>哔哩哔哩个人空间</title>",
      }));
      await bridgeContext.route("https://api.bilibili.com/x/web-interface/nav", (route) => route.fulfill({
        contentType: "application/json", headers: corsFor(route.request()),
        body: JSON.stringify({ code: 0, data: { isLogin: true, mid: 123, uname: "测试账号" } }),
      }));
      await bridgeContext.route("https://api.bilibili.com/x/relation/followings?**", (route) => route.fulfill({
        contentType: "application/json", headers: corsFor(route.request()),
        body: JSON.stringify({ code: 0, data: { total: 1, list: [{ mid: 456, uname: "测试博主" }] } }),
      }));

      const pageUrls = {
        www: "https://www.bilibili.com/",
        api: "https://api.bilibili.com/x/web-interface/nav",
        // The following-list page itself, which the remediation message tells users to use.
        space: "https://space.bilibili.com/123/relation/following",
      };
      const appPage = await bridgeContext.newPage();
      await appPage.goto(`${baseUrl}/following`, { waitUntil: "domcontentloaded" });
      await appPage.getByRole("button", { name: "从平台提取" }).click();
      await appPage.getByRole("button", { name: "连接当前哔站页面" }).click();
      const script = await appPage.getByRole("textbox", { name: "哔站连接脚本" }).inputValue();
      const biliPage = await bridgeContext.newPage();
      await biliPage.goto(pageUrls[source], { waitUntil: "domcontentloaded" });
      const popupPromise = biliPage.waitForEvent("popup", { timeout: 10_000 });
      const scriptRun = biliPage.evaluate(script);
      const receiver = await popupPromise;
      await scriptRun;
      await appPage.getByText("已从当前哔站页面取得关注名单，请检查并选择要追加的博主").waitFor({ timeout: 10_000 });
      if (!receiver || !(await appPage.locator(".collector-preview").innerText()).includes("测试博主")) {
        throw new Error(`${source} 页面未将关注名单传回本站`);
      }
      console.log(`PASS  从 bilibili ${source} 页面跨域连接并显示关注名单`);
    } finally {
      await bridgeContext.close();
    }
  }
} finally {
  await browser.close();
}
