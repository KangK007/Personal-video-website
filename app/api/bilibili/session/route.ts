import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkBilibiliLogin, type BilibiliSessionState } from "@/lib/bilibili-browser";
import { assertLocalRequest, LocalApiRequestError } from "@/lib/local-api-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_MS: Record<BilibiliSessionState["status"], number> = {
  "logged-in": 5 * 60_000,
  "logged-out": 60_000,
  unavailable: 30_000,
};

type CacheEntry = { state: BilibiliSessionState; at: number; fingerprint: string };

let cached: CacheEntry | null = null;

function cookieFilePath() {
  const configured = process.env.BILIBILI_COOKIE_FILE?.trim() || ".local/bilibili-cookie.txt";
  return path.isAbsolute(configured)
    ? configured
    : path.join(/* turbopackIgnore: true */ process.cwd(), configured);
}

/**
 * Identifies the credential the sidecar *would* load. The sidecar reads its cookie
 * once at startup, so a changed file means this cache must be re-probed (and the
 * remediation message tells the user to restart the site so the sidecar reloads it).
 */
async function cookieFingerprint() {
  try {
    const stat = await fs.stat(cookieFilePath());
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
  } catch (error) {
    const status = error instanceof LocalApiRequestError ? error.status : 403;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "请求不受支持" },
      { status },
    );
  }

  const fingerprint = await cookieFingerprint();
  if (cached && cached.fingerprint === fingerprint
    && Date.now() - cached.at < CACHE_TTL_MS[cached.state.status]) {
    return NextResponse.json(cached.state);
  }

  let state: BilibiliSessionState;
  try {
    state = await checkBilibiliLogin(request.signal);
  } catch {
    state = { status: "unavailable", message: "无法检查哔站登录状态" };
  }

  // A cancelled probe says nothing about the credential; never cache it.
  if (request.signal.aborted) {
    return NextResponse.json({ status: "unavailable", message: "登录状态检查已取消" });
  }
  cached = { state, at: Date.now(), fingerprint };
  return NextResponse.json(state);
}
