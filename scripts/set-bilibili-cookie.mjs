import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  buildCookieHeader,
  mergeAnonymousCookies,
  missingRequiredCookies,
  parseCookieInput,
} from "./bilibili-cookie.mjs";

const projectRoot = process.cwd();
const inputPath = path.resolve(process.argv[2] ?? ".local/cookie-input.txt");
const cookieFile = path.join(projectRoot, ".local", "bilibili-cookie.txt");
const BUVID_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0";

const pairs = parseCookieInput(readFileSync(inputPath, "utf8"));
const missing = missingRequiredCookies(pairs);
if (missing.length) {
  throw new Error(`缺少必需 Cookie：${missing.join(", ")}。请从浏览器开发者工具复制 SESSDATA、bili_jct、DedeUserID。`);
}

// A fresh buvid3/buvid4 pair is what an anonymous browser would attach; some
// Bilibili endpoints use it for anti-bot bookkeeping even with a session cookie.
try {
  const response = await fetch("https://www.bilibili.com/", {
    headers: {
      "user-agent": BUVID_UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
  mergeAnonymousCookies(pairs, setCookies);
} catch (error) {
  console.warn(`未能获取匿名 buvid（不影响主要验证）：${error.message}`);
}

const header = buildCookieHeader(pairs);
if (existsSync(cookieFile)) {
  copyFileSync(cookieFile, `${cookieFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
}
const temporary = `${cookieFile}.tmp-${process.pid}`;
writeFileSync(temporary, header, "utf8");
renameSync(temporary, cookieFile);
console.log(`COOKIE_WRITTEN names=${[...pairs.keys()].join(",")} length=${header.length}`);
console.log("请重启网站让本机抓取服务重新读取 Cookie：npm run stop:local && npm run start:local");
