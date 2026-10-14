import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let POST: typeof import("@/app/api/metadata/route").POST;

beforeAll(async () => {
  ({ POST } = await import("@/app/api/metadata/route"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function metadataRequest(url: string) {
  return new Request("http://127.0.0.1:3000/api/metadata", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ url }),
  });
}

function htmlResponse(html: string) {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("metadata route", () => {
  it("rejects a platform homepage before making an outbound request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(metadataRequest("https://www.bilibili.com/"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("视频详情链接") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the canonical detail URL after resolving a supported short link", async () => {
    const canonicalUrl = "https://www.bilibili.com/video/BV1abcDEF12";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: canonicalUrl },
      }))
      .mockResolvedValueOnce(htmlResponse('<meta property="og:title" content="测试视频"><meta property="og:image" content="https://i.example/cover.jpg">'));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(metadataRequest("https://b23.tv/Abc_123"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      title: "测试视频",
      coverUrl: "https://i.example/cover.jpg",
      url: canonicalUrl,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["BV123456", `BV${"a".repeat(32)}`])("reads metadata for a supported BVID boundary %s", async (bvid) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(htmlResponse('<meta property="og:title" content="边界作品">'));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(metadataRequest(`https://www.bilibili.com/video/${bvid}`));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a BVID beyond the supported length before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(metadataRequest(`https://www.bilibili.com/video/BV${"a".repeat(33)}`));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a short link that does not resolve to a video detail page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(htmlResponse("<title>短链接页面</title>")));

    const response = await POST(metadataRequest("https://b23.tv/Abc_123"));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("没有跳转") });
  });

  it("decodes HTML entities exactly once", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(htmlResponse(
      '<meta property="og:title" content="A &amp;lt; B &#39;ok&#39; &#x27;x&#x27;">',
    )));

    const response = await POST(metadataRequest("https://www.bilibili.com/video/BV1abcDEF12"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ title: "A &lt; B 'ok' 'x'" });
  });

  it("keeps metadata when a direct video link redirects to a share page", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://www.iesdouyin.com/share/video/7201234567890123456/" },
      }))
      .mockResolvedValueOnce(htmlResponse('<meta property="og:title" content="抖音分享页">'));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(metadataRequest("https://www.douyin.com/video/7201234567890123456"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ title: "抖音分享页" });
  });

  it("reads metadata from a page far larger than the byte cap", async () => {
    // Real Bilibili/Douyin detail pages are several megabytes; the metadata tags are
    // in <head>, so the body is streamed only until </head>.
    const head = '<head><meta property="og:title" content="超大页面"><meta property="og:image" content="https://i.example/big.jpg"></head>';
    const filler = "x".repeat(3 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(htmlResponse(`${head}<body>${filler}</body>`)));

    const response = await POST(metadataRequest("https://www.bilibili.com/video/BV1abcDEF12"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      title: "超大页面",
      coverUrl: "https://i.example/big.jpg",
    });
  });

  it("reports a redirect without a target address instead of a redirect loop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 302 })));

    const response = await POST(metadataRequest("https://b23.tv/Abc_123"));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("跳转缺少目标地址") });
  });
});
