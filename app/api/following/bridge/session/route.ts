import { NextResponse } from "next/server";
import { LocalApiRequestError, readLocalJsonRequest } from "@/lib/local-api-request";
import { createFollowingBridgeSession } from "@/lib/server/following-bridge";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await readLocalJsonRequest(request, 2_048);
  } catch (error) {
    const status = error instanceof LocalApiRequestError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "请求格式不正确" }, { status });
  }
  return NextResponse.json(createFollowingBridgeSession(), { headers: { "cache-control": "no-store" } });
}
