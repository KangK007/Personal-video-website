import "server-only";

const JSON_MEDIA_TYPE = "application/json";

export class LocalApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LocalApiRequestError";
    this.status = status;
  }
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

function parseAuthority(protocol: string, authority: string) {
  if (!authority || /[\s/?#\\]/.test(authority)) {
    throw new LocalApiRequestError("请求 Host 不受支持", 403);
  }

  try {
    const url = new URL(`${protocol}//${authority}`);
    if (url.username || url.password || !isLoopbackHost(url.hostname)) {
      throw new LocalApiRequestError("仅允许从本机回环地址访问", 403);
    }
    return url;
  } catch (error) {
    if (error instanceof LocalApiRequestError) throw error;
    throw new LocalApiRequestError("请求 Host 不受支持", 403);
  }
}

function effectivePort(url: URL) {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

export function assertLocalRequest(request: Request) {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    throw new LocalApiRequestError("请求地址无效", 400);
  }

  if (
    !["http:", "https:"].includes(requestUrl.protocol)
    || !isLoopbackHost(requestUrl.hostname)
    || requestUrl.username
    || requestUrl.password
  ) {
    throw new LocalApiRequestError("仅允许从本机回环地址访问", 403);
  }

  const hostUrl = parseAuthority(requestUrl.protocol, request.headers.get("host") ?? "");
  // Next may normalize Request.url to localhost even when the browser used 127.0.0.1.
  // The Host header remains authoritative, but its protocol and port must match.
  if (hostUrl.protocol !== requestUrl.protocol || effectivePort(hostUrl) !== effectivePort(requestUrl)) {
    throw new LocalApiRequestError("请求 Host 与访问地址不一致", 403);
  }

  const originHeader = request.headers.get("origin");
  if (!originHeader) {
    throw new LocalApiRequestError("请求缺少 Origin", 403);
  }

  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    throw new LocalApiRequestError("请求 Origin 无效", 403);
  }
  if (
    originUrl.origin !== hostUrl.origin
    || originUrl.pathname !== "/"
    || originUrl.search
    || originUrl.hash
    || originUrl.username
    || originUrl.password
  ) {
    throw new LocalApiRequestError("仅允许同源请求", 403);
  }

}

async function readLimitedText(request: Request, maxBytes: number) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new LocalApiRequestError("Content-Length 无效", 400);
    }
    if (Number(contentLength) > maxBytes) {
      throw new LocalApiRequestError("请求正文过大", 413);
    }
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LocalApiRequestError("请求正文过大", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof LocalApiRequestError) throw error;
    if (request.signal.aborted) {
      throw new LocalApiRequestError("请求已取消", 499);
    }
    throw new LocalApiRequestError("请求正文无法读取", 400);
  } finally {
    reader.releaseLock();
  }
}

export async function readLocalJsonRequest(request: Request, maxBytes: number): Promise<unknown> {
  assertLocalRequest(request);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new LocalApiRequestError("请求必须使用 application/json", 415);
  }
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new LocalApiRequestError("不支持压缩的请求正文", 415);
  }
  const text = await readLimitedText(request, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LocalApiRequestError("请求格式不正确", 400);
  }
}
