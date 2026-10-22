import { NextResponse } from "next/server";
import { LocalApiRequestError, readLocalJsonRequest } from "@/lib/local-api-request";
import { consumeFollowingBridgePayload, getFollowingBridgeStatus } from "@/lib/server/following-bridge";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await readLocalJsonRequest(request, 2_048);
  } catch (error) {
    const status = error instanceof LocalApiRequestError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "请求格式不正确" }, { status });
  }
  const token = body && typeof body === "object" && !Array.isArray(body) && typeof (body as { token?: unknown }).token === "string"
    ? (body as { token: string }).token.trim() : "";
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) return NextResponse.json({ error: "连接令牌无效" }, { status: 400 });

  const status = getFollowingBridgeStatus(token);
  if (status === "unknown" || status === "consumed") {
    return NextResponse.json(
      { error: "浏览器连接已失效（已过期、已完成或网站已重启），请重新连接当前哔站页面" },
      { status: 410, headers: NO_STORE },
    );
  }
  if (status === "pending") return NextResponse.json({ pending: true }, { status: 202, headers: NO_STORE });

  const payload = consumeFollowingBridgePayload(token);
  if (!payload) {
    return NextResponse.json({ error: "浏览器连接结果已被读取，请重新连接" }, { status: 410, headers: NO_STORE });
  }
  return NextResponse.json({ pending: false, ...payload }, { headers: NO_STORE });
}
