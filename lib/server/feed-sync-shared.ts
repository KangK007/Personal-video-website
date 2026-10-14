import "server-only";

export type Platform = "douyin" | "bilibili";

export type CreatorInput = {
  id: string;
  platform: Platform;
  profileUrl: string;
  name: string;
  knownVideoIds?: string[];
};

export type SyncMode = "snapshot" | "incremental";

export type SyncResult = {
  creatorId: string;
  status: "success" | "error";
  count: number;
  complete: boolean;
  mode: SyncMode;
  message?: string;
  failureCode?: string;
  profile?: CreatorProfile;
};

export type CreatorProfile = {
  name?: string;
  avatarUrl?: string;
};

export type SyncedCreator = {
  videos: NormalizedVideo[];
  mode: SyncMode;
  profile?: CreatorProfile;
};

export type NormalizedVideo = {
  id: string;
  platform: Platform;
  videoUrl: string;
  creatorId: string;
  title: string;
  coverUrl?: string;
  publishedAt?: string;
  duration?: string;
  source: "feed-sync";
  createdAt: string;
};

const ALLOWED_PROFILE_HOSTS = [
  "douyin.com",
  "iesdouyin.com",
  "bilibili.com",
  "b23.tv",
];

export function createAbortError() {
  return typeof DOMException !== "undefined"
    ? new DOMException("同步已取消", "AbortError")
    : Object.assign(new Error("同步已取消"), { name: "AbortError" });
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
}

export function waitWithSignal(milliseconds: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isTransientRequestError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError"
    || /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|超时/i.test(error.message);
}

export function isPlatformHost(platform: Platform, hostname: string) {
  const hosts = platform === "douyin"
    ? ["douyin.com", "iesdouyin.com"]
    : ["bilibili.com", "b23.tv"];
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

export function normalizeProfileUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    const isAllowedHost = ALLOWED_PROFILE_HOSTS.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !isAllowedHost) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function getCreatorIdentityKey(platform: Platform, profileUrl: string) {
  const url = new URL(profileUrl);
  const id = platform === "douyin"
    ? url.pathname.match(/^\/user\/([^/]+)\/?$/i)?.[1]
    : url.pathname.match(/^\/(?:space\/)?(\d+)(?:\/|$)/i)?.[1];
  if (id) return `${platform}:creator:${id}`;
  return `${platform}:url:${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "") || "/"}`;
}

export function isPlatformProfileUrl(platform: Platform, profileUrl: string) {
  const url = new URL(profileUrl);
  if (platform === "douyin") {
    return isPlatformHost(platform, url.hostname) && /^\/user\/[^/]+\/?$/i.test(url.pathname);
  }
  return (url.hostname === "space.bilibili.com" && /^\/\d+(?:\/.*)?$/.test(url.pathname))
    || (/^\/space\/\d+(?:\/.*)?$/.test(url.pathname) && isPlatformHost(platform, url.hostname));
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function firstString(...values: unknown[]) {
  for (const value of values) {
    const result = asString(value);
    if (result) return result;
  }
  return "";
}

export function unwrapPayload(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const record = asRecord(current);
    if (!("data" in record)) break;
    current = record.data;
  }
  return current;
}

export function toIsoDate(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function formatDuration(
  value: unknown,
  unit: "seconds" | "milliseconds" = "seconds",
) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const total = Math.round(unit === "milliseconds" ? numeric / 1000 : numeric);
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function normalizeMediaUrl(value: unknown) {
  const raw = asString(value);
  if (!raw || raw.length > 2048) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizePlatformVideoUrl(value: unknown, platform: Platform) {
  const raw = normalizeMediaUrl(value);
  if (!raw) return "";
  const url = new URL(raw);
  if (!isPlatformHost(platform, url.hostname)) return "";
  url.search = "";
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function firstImageUrl(value: unknown) {
  const image = asRecord(value);
  const urls = Array.isArray(image.url_list) ? image.url_list : [];
  return normalizeMediaUrl(firstString(urls[0], image.url));
}

export function normalizeCreatorProfile(
  name: unknown,
  avatarUrl: unknown,
): CreatorProfile | undefined {
  const profile: CreatorProfile = {};
  const normalizedName = asString(name).slice(0, 80);
  const normalizedAvatarUrl = normalizeMediaUrl(avatarUrl);
  if (normalizedName) profile.name = normalizedName;
  if (normalizedAvatarUrl) profile.avatarUrl = normalizedAvatarUrl;
  return profile.name || profile.avatarUrl ? profile : undefined;
}
