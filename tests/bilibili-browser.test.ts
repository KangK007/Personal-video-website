import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  launch: vi.fn(),
  createContext: vi.fn(),
  resolveBrowserExecutable: vi.fn(),
  closeBrowser: vi.fn(),
  closeContext: vi.fn(),
  closePage: vi.fn(),
  goto: vi.fn(),
  evaluate: vi.fn(),
  waitForResponse: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("node:fs", () => ({ promises: { stat: mocks.stat, readFile: mocks.readFile } }));
vi.mock("playwright-core", () => ({ chromium: { launch: mocks.launch } }));
vi.mock("@/lib/douyin-browser", () => ({
  createContext: mocks.createContext,
  resolveBrowserExecutable: mocks.resolveBrowserExecutable,
}));

import { collectBilibiliFollowing, interpretBilibiliNav } from "@/lib/bilibili-browser";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.closeContext.mockResolvedValue(undefined);
  mocks.closeBrowser.mockResolvedValue(undefined);
  mocks.closePage.mockResolvedValue(undefined);
  mocks.stat.mockResolvedValue({ isFile: () => true, size: 16 });
  mocks.readFile.mockResolvedValue("SESSDATA=fake; DedeUserID=123");
  mocks.resolveBrowserExecutable.mockResolvedValue("edge.exe");
  mocks.launch.mockResolvedValue({ close: mocks.closeBrowser });
  mocks.createContext.mockResolvedValue({ newPage: async () => ({
    close: mocks.closePage,
    goto: mocks.goto,
    evaluate: mocks.evaluate,
    waitForResponse: mocks.waitForResponse,
  }), close: mocks.closeContext });
  mocks.waitForResponse.mockResolvedValue({ json: async () => ({ code: 0, data: { isLogin: true, mid: 123, uname: "当前账号" } }) });
  mocks.evaluate.mockImplementation(async (_callback: unknown, url: string) => {
    const pn = Number(new URL(url).searchParams.get("pn"));
    return { status: 200, payload: { code: 0, data: { total: 2, list: [{ mid: pn, uname: `博主 ${pn}` }] } } };
  });
});

describe("bilibili browser following collector", () => {
  it("collects multiple pages in the authenticated browser context", async () => {
    const pages: number[] = [];
    const result = await collectBilibiliFollowing((page) => { pages.push(page.received); });
    expect(result).toEqual({ received: 2, total: 2, invalidCount: 0 });
    expect(pages).toEqual([0, 1, 2]);
    expect(mocks.createContext).toHaveBeenCalledWith(expect.anything(), "edge.exe", expect.any(String), ".bilibili.com");
    expect(mocks.evaluate).toHaveBeenCalledTimes(2);
    expect(mocks.closeContext).toHaveBeenCalledOnce();
    expect(mocks.closeBrowser).toHaveBeenCalledOnce();
  });

  it("accepts an explicitly empty list", async () => {
    mocks.evaluate.mockResolvedValue({ status: 200, payload: { code: 0, data: { total: 0, list: [] } } });
    await expect(collectBilibiliFollowing(() => undefined)).resolves.toEqual({ received: 0, total: 0, invalidCount: 0 });
  });

  it("rejects an expired login and closes the browser", async () => {
    mocks.waitForResponse.mockResolvedValue({ json: async () => ({ code: -101, data: { isLogin: false } }) });
    await expect(collectBilibiliFollowing(() => undefined)).rejects.toThrow("请更新 Cookie");
    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(mocks.closeContext).toHaveBeenCalledOnce();
    expect(mocks.closeBrowser).toHaveBeenCalledOnce();
  });

  it("keeps records with invalid IDs from being marked complete", async () => {
    mocks.evaluate.mockResolvedValue({ status: 200, payload: { code: 0, data: { total: 1, list: [{ uname: "缺少 UID" }] } } });
    await expect(collectBilibiliFollowing(() => undefined)).rejects.toThrow("未完整提取");
    expect(mocks.closeBrowser).toHaveBeenCalledOnce();
  });

  it("closes the page and browser when collection is cancelled", async () => {
    const controller = new AbortController();
    await expect(collectBilibiliFollowing(() => { controller.abort(); }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.closePage).toHaveBeenCalledOnce();
    expect(mocks.closeContext).toHaveBeenCalledOnce();
    expect(mocks.closeBrowser).toHaveBeenCalledOnce();
  });
});

describe("interpretBilibiliNav", () => {
  it("recognizes a logged-in account", () => {
    expect(interpretBilibiliNav({ code: 0, data: { isLogin: true, uname: "测试账号" } }))
      .toEqual({ status: "logged-in", accountName: "测试账号" });
  });

  it("treats an authentic not-logged-in answer as an expired cookie", () => {
    expect(interpretBilibiliNav({ code: -101, data: { isLogin: false } })).toMatchObject({ status: "logged-out" });
    expect(interpretBilibiliNav({ code: 0, data: { isLogin: false } })).toMatchObject({ status: "logged-out" });
  });

  it("does not call risk control or unexpected payloads 'logged-out'", () => {
    // These say nothing about the cookie; blocking the platform would be wrong.
    expect(interpretBilibiliNav({ code: -352, message: "风控校验失败" })).toMatchObject({ status: "unavailable" });
    expect(interpretBilibiliNav({ code: -412 })).toMatchObject({ status: "unavailable" });
    expect(interpretBilibiliNav({ code: 0 })).toMatchObject({ status: "unavailable" });
    expect(interpretBilibiliNav({})).toMatchObject({ status: "unavailable" });
  });
});
