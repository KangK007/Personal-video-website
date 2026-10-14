import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 1_500;
const MAX_COOKIE_BYTES = 64 * 1024;

function isLoopbackHost(hostname: string) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

function getSidecarUrl() {
  const raw = process.env.FEED_SIDECAR_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!isLoopbackHost(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function probeFetch(url: URL, token?: string) {
  // Each probe request gets its own deadline: sharing one controller across
  // sequential requests reports a healthy but slow sidecar as timed out.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function discardBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing a probe response body is best effort only.
  }
}

async function probeSidecar(baseUrl: string | null) {
  if (!baseUrl) return { configured: false, healthy: false, message: "未配置本机抓取服务" };
  const token = process.env.FEED_SIDECAR_TOKEN?.trim();
  if (!token) return { configured: true, healthy: false, message: "本机抓取服务令牌未配置" };
  try {
    const openApiResponse = await probeFetch(new URL("openapi.json", `${baseUrl}/`));
    await discardBody(openApiResponse);
    if (!openApiResponse.ok) {
      return { configured: true, healthy: false, message: `本机抓取服务返回 ${openApiResponse.status}` };
    }
    const authProbeUrl = new URL("__local_auth_probe__", `${baseUrl}/`);
    const unauthenticatedResponse = await probeFetch(authProbeUrl);
    await discardBody(unauthenticatedResponse);
    const authResponse = await probeFetch(authProbeUrl, token);
    await discardBody(authResponse);
    if (unauthenticatedResponse.status !== 401) {
      return { configured: true, healthy: false, message: "本机抓取服务未启用鉴权" };
    }
    return authResponse.status === 401
      ? { configured: true, healthy: false, message: "本机抓取服务令牌不匹配，请重新运行设置脚本" }
      : { configured: true, healthy: true };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "本机抓取服务响应超时"
      : "本机抓取服务未启动或无法连接";
    return { configured: true, healthy: false, message };
  }
}

async function hasDouyinCookie() {
  const configured = process.env.DOUYIN_COOKIE_FILE?.trim() || ".local/douyin-cookie.txt";
  const cookiePath = path.isAbsolute(configured) ? configured : path.join(/* turbopackIgnore: true */ process.cwd(), configured);
  try {
    const stat = await fs.stat(cookiePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_COOKIE_BYTES) return false;
    const value = (await fs.readFile(cookiePath, "utf8")).trim();
    return Boolean(value) && !/[\r\n]/.test(value);
  } catch {
    return false;
  }
}

async function hasBrowserExecutable() {
  const candidates = [
    process.env.DOUYIN_BROWSER_EXECUTABLE?.trim(),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return true;
    } catch {
      // Continue through the standard browser locations.
    }
  }
  return false;
}

export async function GET() {
  const [sidecar, cookieReady, browserReady] = await Promise.all([
    probeSidecar(getSidecarUrl()),
    hasDouyinCookie(),
    hasBrowserExecutable(),
  ]);
  return NextResponse.json({
    ok: true,
    services: {
      douyin: {
        configured: cookieReady && browserReady,
        cookieReady,
        browserReady,
        message: !cookieReady
          ? "未找到有效的抖音 Cookie"
          : !browserReady
            ? "未找到 Edge 或 Chrome"
            : undefined,
      },
      bilibili: sidecar,
    },
  });
}
