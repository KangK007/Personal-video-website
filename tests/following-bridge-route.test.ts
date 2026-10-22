import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let bridgePost: typeof import("@/app/api/following/bridge/route").POST;
let sessionPost: typeof import("@/app/api/following/bridge/session/route").POST;
let resultPost: typeof import("@/app/api/following/bridge/result/route").POST;

beforeAll(async () => {
  ({ POST: bridgePost } = await import("@/app/api/following/bridge/route"));
  ({ POST: sessionPost } = await import("@/app/api/following/bridge/session/route"));
  ({ POST: resultPost } = await import("@/app/api/following/bridge/result/route"));
});

function localRequest(body: unknown) {
  return new Request("http://127.0.0.1:3000/api/following/bridge/session", {
    method: "POST",
    headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("following browser bridge routes", () => {
  it("rejects cross-origin payloads", async () => {
    const denied = await bridgePost(new Request("http://127.0.0.1:3000/api/following/bridge", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "https://api.bilibili.com", "content-type": "application/json" },
      body: "{}",
    }));
    expect(denied.status).toBe(403);
  });

  it("receives one browser payload and returns it to the local poller", async () => {
    const sessionResponse = await sessionPost(localRequest({}));
    const session = await sessionResponse.json() as { token: string };
    const bridgeResponse = await bridgePost(new Request("http://127.0.0.1:3000/api/following/bridge", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ token: session.token, payload: { account: { id: "9", name: "账号" }, total: 1, creators: [{ platformUserId: "8", name: "作者" }] } }),
    }));
    expect(bridgeResponse.status).toBe(200);
    const resultResponse = await resultPost(new Request("http://127.0.0.1:3000/api/following/bridge/result", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ token: session.token }),
    }));
    expect(resultResponse.status).toBe(200);
    expect(await resultResponse.json()).toMatchObject({ account: { id: "9" }, result: { status: "complete", received: 1 } });
    const consumed = await resultPost(new Request("http://127.0.0.1:3000/api/following/bridge/result", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ token: session.token }),
    }));
    expect(consumed.status).toBe(202);
  });
});
