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

let cached: { state: BilibiliSessionState; at: number } | null = null;

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

  if (cached && Date.now() - cached.at < CACHE_TTL_MS[cached.state.status]) {
    return NextResponse.json(cached.state);
  }

  let state: BilibiliSessionState;
  try {
    state = await checkBilibiliLogin(request.signal);
  } catch {
    state = { status: "unavailable", message: "无法检查哔站登录状态" };
  }
  cached = { state, at: Date.now() };
  return NextResponse.json(state);
}
