import { NextResponse } from "next/server";
import { LocalApiRequestError, readLocalJsonRequest } from "@/lib/local-api-request";
import { consumeFollowingBridgePayload } from "@/lib/server/following-bridge";

export const runtime = "nodejs";

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
  const payload = consumeFollowingBridgePayload(token);
  if (!payload) return NextResponse.json({ pending: true }, { status: 202, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ pending: false, ...payload }, { headers: { "cache-control": "no-store" } });
}
