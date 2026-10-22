import "server-only";

import { randomBytes } from "node:crypto";
import {
  cleanFollowingName,
  followingAvatar,
  followingProfileUrl,
  FOLLOWING_LIMIT,
  validFollowingId,
  type FollowingCreator,
  type FollowingResult,
} from "@/lib/following-list";

const SESSION_TTL_MS = 10 * 60 * 1_000;
const MAX_SESSIONS = 8;

export type FollowingBridgePayload = {
  account: { id: string; name: string };
  creators: FollowingCreator[];
  result: FollowingResult;
};

type BridgeSession = {
  expiresAt: number;
  payload?: FollowingBridgePayload;
  consumed: boolean;
};

type BridgeState = typeof globalThis & {
  __justFollowFollowingBridge?: Map<string, BridgeSession>;
};

function sessions() {
  const state = globalThis as BridgeState;
  state.__justFollowFollowingBridge ??= new Map();
  return state.__justFollowFollowingBridge;
}

function removeExpired(now = Date.now()) {
  const store = sessions();
  for (const [token, session] of store) {
    if (session.expiresAt <= now || session.consumed) store.delete(token);
  }
}

export function createFollowingBridgeSession() {
  const now = Date.now();
  removeExpired(now);
  const store = sessions();
  while (store.size >= MAX_SESSIONS) {
    const oldest = store.keys().next().value;
    if (typeof oldest !== "string") break;
    store.delete(oldest);
  }
  const token = randomBytes(32).toString("base64url");
  store.set(token, { expiresAt: now + SESSION_TTL_MS, consumed: false });
  return { token, expiresAt: now + SESSION_TTL_MS };
}

export function getFollowingBridgeSession(token: string) {
  removeExpired();
  return sessions().get(token);
}

export type FollowingBridgeStatus = "unknown" | "consumed" | "pending" | "ready";

/** Distinguishes "not delivered yet" from "the session is gone" for the polling UI. */
export function getFollowingBridgeStatus(token: string): FollowingBridgeStatus {
  const session = getFollowingBridgeSession(token);
  if (!session) return "unknown";
  if (session.consumed) return "consumed";
  return session.payload ? "ready" : "pending";
}

export function setFollowingBridgePayload(token: string, payload: FollowingBridgePayload) {
  const session = getFollowingBridgeSession(token);
  if (!session || session.consumed || session.payload) return false;
  session.payload = payload;
  return true;
}

export function consumeFollowingBridgePayload(token: string) {
  const session = getFollowingBridgeSession(token);
  if (!session || session.consumed || !session.payload) return null;
  session.consumed = true;
  return session.payload;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeFollowingBridgePayload(value: unknown): FollowingBridgePayload {
  const root = asRecord(value);
  const account = asRecord(root.account);
  const rawCreators = Array.isArray(root.creators) ? root.creators : [];
  if (rawCreators.length > FOLLOWING_LIMIT) throw new Error("浏览器返回的关注名单超过 10,000 位");
  if (typeof account.id !== "string" || !validFollowingId("bilibili", account.id)) throw new Error("哔站登录账号 UID 无效");
  const creators = new Map<string, FollowingCreator>();
  const reportedInvalidCount = Number(root.invalidCount ?? 0);
  if (!Number.isSafeInteger(reportedInvalidCount) || reportedInvalidCount < 0 || reportedInvalidCount > FOLLOWING_LIMIT) {
    throw new Error("浏览器返回的异常记录数无效");
  }
  let invalidCount = reportedInvalidCount;
  for (const raw of rawCreators) {
    const item = asRecord(raw);
    const id = String(item.platformUserId ?? "");
    if (!validFollowingId("bilibili", id)) { invalidCount += 1; continue; }
    const avatarUrl = followingAvatar(item.avatarUrl);
    const creator: FollowingCreator = {
      platform: "bilibili",
      platformUserId: id,
      name: cleanFollowingName(item.name, "bilibili"),
      profileUrl: followingProfileUrl("bilibili", id),
      ...(avatarUrl ? { avatarUrl } : {}),
    };
    const key = `${creator.platform}:${creator.platformUserId}`;
    if (!creators.has(key)) creators.set(key, creator);
  }
  const received = creators.size;
  const total = Number(root.total);
  if (!Number.isSafeInteger(total) || total < 0 || total > FOLLOWING_LIMIT) throw new Error("浏览器返回的哔站关注总数无效");
  const result: FollowingResult = {
    platform: "bilibili",
    status: invalidCount || received !== total || root.message ? "partial" : "complete",
    received,
    total,
    invalidCount,
    ...(typeof root.message === "string" ? { message: root.message.slice(0, 300) } : {}),
  };
  return {
    account: { id: account.id, name: cleanFollowingName(account.name, "bilibili") },
    creators: [...creators.values()],
    result,
  };
}
