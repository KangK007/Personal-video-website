import { NextResponse } from "next/server";
import { LocalApiRequestError, readLocalJsonRequest } from "@/lib/local-api-request";
import { normalizeFollowingBridgePayload, setFollowingBridgePayload } from "@/lib/server/following-bridge";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await readLocalJsonRequest(request, MAX_BODY_BYTES);
  } catch (error) {
    const status = error instanceof LocalApiRequestError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "请求格式不正确" }, { status });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "浏览器返回的数据格式无效" }, { status: 400 });
  }
  const { token, payload } = body as { token?: unknown; payload?: unknown };
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    return NextResponse.json({ error: "连接令牌无效或已过期" }, { status: 401 });
  }
  try {
    const normalized = normalizeFollowingBridgePayload(payload);
    if (!setFollowingBridgePayload(token, normalized)) {
      return NextResponse.json({ error: "连接令牌无效、已过期或已使用" }, { status: 409 });
    }
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "浏览器返回的数据无效" }, { status: 400 });
  }
}
