import { NextResponse } from "next/server";
import { readLocalJsonRequest, LocalApiRequestError } from "@/lib/local-api-request";
import { isFollowingPlatform, type FollowingResult } from "@/lib/following-list";
import { collectBilibili, collectDouyin } from "@/lib/server/following";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 16 * 1024;
type LockState = typeof globalThis & { __justFollowFollowingRunning?: boolean };

function acquireLock() {
  const state = globalThis as LockState;
  if (state.__justFollowFollowingRunning) return null;
  state.__justFollowFollowingRunning = true;
  return () => { state.__justFollowFollowingRunning = false; };
}

function writeEvent(controller: ReadableStreamDefaultController<Uint8Array>, event: unknown) {
  controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
}

function retryableCollectionError(error: unknown) {
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  return error.name === "TimeoutError" || /超时|网络|连接|暂时不可用|接口返回 5\d\d/i.test(error.message);
}

async function waitBeforeRetry(attempt: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, attempt === 0 ? 2000 : 5000);
    const abort = () => { clearTimeout(timer); reject(new DOMException("提取已取消", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await readLocalJsonRequest(request, MAX_BODY_BYTES); } catch (error) {
    const status = error instanceof LocalApiRequestError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "请求格式不正确" }, { status });
  }
  const platforms = Array.isArray((body as { platforms?: unknown })?.platforms)
    ? [...new Set((body as { platforms: unknown[] }).platforms.filter(isFollowingPlatform))] : [];
  if (!platforms.length || platforms.length > 2 || platforms.length !== ((body as { platforms?: unknown[] })?.platforms?.length ?? 0)) {
    return NextResponse.json({ error: "请选择抖音或哔站平台" }, { status: 400 });
  }
  const release = acquireLock();
  if (!release) return NextResponse.json({ error: "已有关注名单提取正在进行，请等待完成" }, { status: 409 });
  let cancelTask: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const results: FollowingResult[] = [];
      const taskController = new AbortController();
      cancelTask = () => taskController.abort();
      const abortTask = () => taskController.abort();
      request.signal.addEventListener("abort", abortTask, { once: true });
      let streamClosed = false;
      const closeStream = () => {
        if (streamClosed) return;
        streamClosed = true;
        try { controller.close(); } catch { /* Client disconnected. */ }
      };
      const run = async () => {
        try {
          for (const platform of platforms) {
            const state = { received: 0, total: 0, invalidCount: 0 };
            // A retry restarts the platform collector from page 1; accumulate the
            // union so the reported count never regresses below what was streamed.
            const seenIds = new Set<string>();
            const callbacks = {
              account: (source: "douyin" | "bilibili", account: { id: string; name: string }) => writeEvent(controller, { type: "account", platform: source, account }),
              page: (source: "douyin" | "bilibili", creators: unknown[], received: number, total: number, invalidCount: number) => {
                for (const creator of creators) {
                  const id = (creator as { platformUserId?: unknown }).platformUserId;
                  if (typeof id === "string" && id) seenIds.add(id);
                }
                state.received = Math.max(state.received, received, seenIds.size);
                state.total = Math.max(state.total, total);
                state.invalidCount = Math.max(state.invalidCount, invalidCount);
                writeEvent(controller, { type: "page", platform: source, creators, received: state.received, total: state.total || total, invalidCount: state.invalidCount });
              },
            };
            try {
              let result: { received: number; total: number; invalidCount: number } | undefined;
              for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                  result = platform === "douyin" ? await collectDouyin(callbacks, taskController.signal) : await collectBilibili(callbacks, taskController.signal);
                  break;
                } catch (error) {
                  // Bilibili retries each browser request in place; restarting the
                  // whole collector would exceed the per-request retry limit.
                  if (platform === "bilibili" || attempt >= 2 || !retryableCollectionError(error)) throw error;
                  await waitBeforeRetry(attempt, taskController.signal);
                }
              }
              if (!result) throw new Error("平台提取未返回结果");
              const final: FollowingResult = {
                platform,
                status: "complete",
                received: Math.max(result.received, state.received),
                total: Math.max(result.total, state.total),
                invalidCount: Math.max(result.invalidCount, state.invalidCount),
              };
              results.push(final); writeEvent(controller, { type: "result", result: final });
            } catch (error) {
              if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
              const final: FollowingResult = { platform, status: state.received ? "partial" : "error", received: state.received, total: state.total || undefined, invalidCount: state.invalidCount, code: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : "平台提取失败" };
              results.push(final); writeEvent(controller, { type: "result", result: final });
            }
          }
          writeEvent(controller, { type: "done" });
          closeStream();
        } catch (error) {
          if (!taskController.signal.aborted) {
            try { writeEvent(controller, { type: "error", error: error instanceof Error ? error.message : "提取失败" }); } catch { /* Client disconnected. */ }
          }
          closeStream();
        } finally { request.signal.removeEventListener("abort", abortTask); release(); }
      };
      void run();
    },
    cancel() { cancelTask(); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
