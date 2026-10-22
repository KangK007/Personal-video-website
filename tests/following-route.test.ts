import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collectDouyin: vi.fn(),
  collectBilibili: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/following", () => ({
  collectDouyin: mocks.collectDouyin,
  collectBilibili: mocks.collectBilibili,
}));

let POST: typeof import("@/app/api/following/collect/route").POST;

beforeAll(async () => {
  ({ POST } = await import("@/app/api/following/collect/route"));
});

afterEach(() => {
  mocks.collectDouyin.mockReset();
  mocks.collectBilibili.mockReset();
});

function request(body: unknown) {
  return new Request("http://127.0.0.1:3000/api/following/collect", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("following collection route", () => {
  it("rejects unsupported platforms before starting a collector", async () => {
    const response = await POST(request({ platforms: ["youtube"] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "请选择抖音或哔站平台" });
    expect(mocks.collectDouyin).not.toHaveBeenCalled();
  });

  it("continues with the second platform after a first platform error", async () => {
    mocks.collectDouyin.mockRejectedValue(new Error("抖音 Cookie 无效"));
    mocks.collectBilibili.mockImplementation(async (callbacks: { account: Function; page: Function }) => {
      callbacks.account("bilibili", { id: "1", name: "测试账号" });
      callbacks.page("bilibili", [{ platform: "bilibili", platformUserId: "2", name: "作者", profileUrl: "https://space.bilibili.com/2" }], 1, 1, 0);
      return { received: 1, total: 1, invalidCount: 0 };
    });
    const response = await POST(request({ platforms: ["douyin", "bilibili"] }));
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; result?: { platform: string; status: string } });
    expect(mocks.collectBilibili).toHaveBeenCalledTimes(1);
    expect(lines.some((line) => line.type === "result" && line.result?.platform === "douyin" && line.result.status === "error")).toBe(true);
    expect(lines.some((line) => line.type === "result" && line.result?.platform === "bilibili" && line.result.status === "complete")).toBe(true);
    expect(lines.at(-1)?.type).toBe("done");
  });

  it("keeps the task lock until a cancelled collector has finished cleanup", async () => {
    let finishCollector: ((result: { received: number; total: number; invalidCount: number }) => void) | undefined;
    mocks.collectDouyin.mockImplementationOnce(() => new Promise((resolve) => {
      finishCollector = resolve;
    }));
    const first = await POST(request({ platforms: ["douyin"] }));
    try {
      await first.body?.cancel();
      const concurrent = await POST(request({ platforms: ["douyin"] }));
      expect(concurrent.status).toBe(409);
    } finally {
      finishCollector?.({ received: 0, total: 0, invalidCount: 0 });
    }
    mocks.collectDouyin.mockResolvedValue({ received: 0, total: 0, invalidCount: 0 });
    await vi.waitFor(async () => {
      const afterCleanup = await POST(request({ platforms: ["douyin"] }));
      expect(afterCleanup.status).toBe(200);
      await afterCleanup.text();
    });
  });
});
