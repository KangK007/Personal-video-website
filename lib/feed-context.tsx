"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  FeedStorageConflictError,
  readFeedState,
  recoverFeedState,
  writeFeedState,
} from "@/lib/feed-storage";
import {
  applyBilibiliRunLimit,
  markBatchFailed,
  mergeRestrictionRetry,
  mergeSyncResponse,
  buildSyncBatches,
  clearSyncErrors,
  computeSyncStatus,
  getBilibiliCooldownMs,
  getDouyinCooldownMs,
  getRestrictedSyncPlatform,
  isProviderFailureError,
  isProviderUnavailableFailure,
  isSyncBusyError,
  MAX_BILIBILI_CREATORS_PER_RUN,
  MAX_CONSECUTIVE_PROVIDER_FAILURES,
  MAX_AUTO_SYNC_ROUNDS,
  AUTO_SYNC_CONTINUE_DELAY_MS,
  requestSyncBatch,
  reconcileSyncBatch,
  shouldAutoContinueSync,
  RESTRICTION_RETRY_DELAY_MS,
  syncRequestError,
  waitWithSignal,
  type SyncProgress,
  type SyncStatus,
} from "@/lib/feed-sync";
import type { Creator, FeedState, VideoItem } from "@/lib/feed-types";

const LEGACY_CREATOR_STORAGE_KEY = "just-follow-feed:creators";
const LEGACY_VIDEO_STORAGE_KEY = "just-follow-feed:videos";
const WRITE_DEBOUNCE_MS = 180;
const SYNC_LOCK_NAME = "just-follow-feed:sync";
const STATE_CHANNEL_NAME = "just-follow-feed:state";

export type StorageStatus = "loading" | "ready" | "empty" | "read-error" | "write-error" | "conflict";

type FeedContextValue = {
  creators: Creator[];
  videos: VideoItem[];
  isHydrated: boolean;
  dataAvailable: boolean;
  storageStatus: StorageStatus;
  storageError: string | null;
  isSaving: boolean;
  setCreators: Dispatch<SetStateAction<Creator[]>>;
  setVideos: Dispatch<SetStateAction<VideoItem[]>>;
  getDataEpoch: () => number;
  replaceState: (next: FeedState) => void;
  retryHydrate: () => void;
  retryPersist: () => void;
  syncStatus: SyncStatus;
  syncState: SyncStatus;
  syncProgress: SyncProgress;
  syncMessage: string;
  syncFeed: (targets?: Creator[]) => Promise<boolean>;
  cancelSync: () => void;
  retryFailed: () => Promise<boolean>;
};

const FeedContext = createContext<FeedContextValue | null>(null);

const EMPTY_PROGRESS: SyncProgress = {
  status: "idle",
  total: 0,
  processed: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  deferred: 0,
  restrictedPlatforms: [],
  currentStart: 0,
  currentEnd: 0,
  message: "",
  failedCreatorIds: [],
  skippedCreatorIds: [],
  runId: 0,
};

type BilibiliSessionProbe = {
  status: "logged-in" | "logged-out" | "unavailable";
  accountName?: string;
  message?: string;
};

/**
 * Best-effort login probe. A failure to run the probe must not block syncing, so
 * only an explicit "logged-out" answer changes the run.
 */
async function probeBilibiliSession(signal: AbortSignal): Promise<BilibiliSessionProbe | null> {
  try {
    const response = await fetch("/api/bilibili/session", { method: "POST", signal });
    if (!response.ok) return null;
    return await response.json() as BilibiliSessionProbe;
  } catch {
    return null;
  }
}

function readLegacyState(): { state: FeedState | null; recoveryMessage?: string } {
  try {
    const creatorsValue = window.localStorage.getItem(LEGACY_CREATOR_STORAGE_KEY);
    const videosValue = window.localStorage.getItem(LEGACY_VIDEO_STORAGE_KEY);
    if (creatorsValue === null && videosValue === null) return { state: null };
    // A partially written legacy cache is best-effort input, not a reason to lock the
    // app: the missing half is treated as empty and unusable values are ignored.
    const recovered = recoverFeedState({
      version: 1,
      creators: JSON.parse(creatorsValue ?? "[]"),
      videos: JSON.parse(videosValue ?? "[]"),
    });
    return {
      state: recovered?.state ?? null,
      ...(recovered?.repaired ? { recoveryMessage: `已从旧版缓存隔离或修复 ${recovered.repaired} 条异常数据记录。` } : {}),
    };
  } catch {
    return { state: null };
  }
}

export function FeedProvider({ children }: { children: ReactNode }) {
  const [creators, setCreatorsState] = useState<Creator[]>([]);
  const [videos, setVideosState] = useState<VideoItem[]>([]);
  const [storageStatus, setStorageStatus] = useState<StorageStatus>("loading");
  const [storageError, setStorageError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [dataAvailable, setDataAvailable] = useState(false);
  const [hydrateAttempt, setHydrateAttempt] = useState(0);
  const [syncProgress, setSyncProgress] = useState<SyncProgress>(EMPTY_PROGRESS);
  const [persistVersion, setPersistVersion] = useState(0);

  const creatorsRef = useRef<Creator[]>([]);
  const videosRef = useRef<VideoItem[]>([]);
  const dataEpochRef = useRef(0);
  // Bumped only by replaceState (import / clear). Regular edits (add, pause,
  // unfollow, delete) must not abort a running sync, so they only bump dataEpoch.
  const dataReplaceEpochRef = useRef(0);
  const persistVersionRef = useRef(0);
  const persistedVersionRef = useRef(0);
  const storageRevisionRef = useRef(0);
  const conflictRevisionRef = useRef<number | null>(null);
  const writerIdRef = useRef("");
  const channelRef = useRef<BroadcastChannel | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const adoptNextWriteRef = useRef(false);
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const syncingRef = useRef(false);
  const autoSyncStartedRef = useRef(false);
  const autoSyncSeenIdsRef = useRef(new Set<string>());
  const pendingAutoSyncIdsRef = useRef(new Set<string>());
  const failedIdsRef = useRef<string[]>([]);

  useEffect(() => {
    writerIdRef.current = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `tab-${performance.timeOrigin}-${performance.now()}`;
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (persistVersionRef.current <= persistedVersionRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const markDirty = useCallback(() => {
    const next = persistVersionRef.current + 1;
    persistVersionRef.current = next;
    setPersistVersion(next);
    setIsSaving(true);
  }, []);

  const setCreators = useCallback<Dispatch<SetStateAction<Creator[]>>>((update) => {
    const current = creatorsRef.current;
    const next = typeof update === "function" ? update(current) : update;
    if (next === current) return;
    dataEpochRef.current += 1;
    creatorsRef.current = next;
    setCreatorsState(next);
    markDirty();
  }, [markDirty]);

  const setVideos = useCallback<Dispatch<SetStateAction<VideoItem[]>>>((update) => {
    const current = videosRef.current;
    const next = typeof update === "function" ? update(current) : update;
    if (next === current) return;
    dataEpochRef.current += 1;
    videosRef.current = next;
    setVideosState(next);
    markDirty();
  }, [markDirty]);

  const replaceState = useCallback((next: FeedState) => {
    dataEpochRef.current += 1;
    dataReplaceEpochRef.current += 1;
    autoSyncSeenIdsRef.current = new Set(next.creators.map((creator) => creator.id));
    pendingAutoSyncIdsRef.current.clear();
    creatorsRef.current = next.creators;
    videosRef.current = next.videos;
    setCreatorsState(next.creators);
    setVideosState(next.videos);
    setDataAvailable(true);
    setStorageStatus("ready");
    setStorageError(null);
    conflictRevisionRef.current = null;
    // Import and clear replace the whole local dataset, so the first write may adopt
    // the stored revision instead of failing when no readable baseline exists.
    adoptNextWriteRef.current = true;
    markDirty();
  }, [markDirty]);

  const getDataEpoch = useCallback(() => dataEpochRef.current, []);

  useEffect(() => {
    creatorsRef.current = creators;
  }, [creators]);

  useEffect(() => {
    videosRef.current = videos;
  }, [videos]);

  useEffect(() => {
    let cancelled = false;
    const epochAtStart = dataEpochRef.current;

    async function hydrate() {
      let state: FeedState | null = null;
      let revision = 0;
      let needsRewrite = false;
      let recoveryMessage: string | undefined;
      let usedLegacyStorage = false;
      let databaseFailed = false;
      let databaseErrorMessage: string | undefined;
      try {
        const stored = await readFeedState();
        if (stored) {
          state = { version: 2, creators: stored.creators, videos: stored.videos };
          revision = stored.revision;
          needsRewrite = Boolean(stored.needsRewrite);
          recoveryMessage = stored.recoveryMessage;
        }
      } catch (error) {
        databaseFailed = true;
        if (error instanceof Error && /其他标签页|打开超时|损坏/.test(error.message)) {
          databaseErrorMessage = error.message;
        }
      }

      if (!state) {
        const legacy = readLegacyState();
        state = legacy.state;
        usedLegacyStorage = Boolean(state);
        recoveryMessage = legacy.recoveryMessage;
      }
      if (cancelled || dataEpochRef.current !== epochAtStart) return;

      if (state) {
        storageRevisionRef.current = revision;
        conflictRevisionRef.current = null;
        persistVersionRef.current = 0;
        persistedVersionRef.current = 0;
        setPersistVersion(0);
        setIsSaving(false);
        creatorsRef.current = state.creators;
        videosRef.current = state.videos;
        setCreatorsState(state.creators);
        setVideosState(state.videos);
        setDataAvailable(true);
        setStorageStatus("ready");
        setStorageError(databaseFailed
          ? `${databaseErrorMessage ?? "本地数据库暂时无法读取。"} 已先载入旧版缓存，请检查后点击重试保存。`
          : recoveryMessage ?? null);
        if (needsRewrite || usedLegacyStorage) markDirty();
        return;
      }

      if (databaseFailed) {
        setDataAvailable(false);
        setStorageStatus("read-error");
        setStorageError(databaseErrorMessage ?? "本地数据读取失败。请重试，或导入之前导出的备份；当前缓存不会被覆盖。");
      } else {
        storageRevisionRef.current = 0;
        conflictRevisionRef.current = null;
        persistVersionRef.current = 0;
        persistedVersionRef.current = 0;
        setPersistVersion(0);
        setIsSaving(false);
        setDataAvailable(true);
        setStorageStatus("empty");
        setStorageError(null);
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [hydrateAttempt, markDirty]);

  useEffect(() => {
    if ((storageStatus !== "ready" && storageStatus !== "empty")
      || !dataAvailable
      || syncingRef.current
      || persistVersion <= persistedVersionRef.current) return;

    const timer = window.setTimeout(() => {
      const targetVersion = persistVersionRef.current;
      const creatorSnapshot = creatorsRef.current;
      const videoSnapshot = videosRef.current;
      const adoptRevision = adoptNextWriteRef.current;
      adoptNextWriteRef.current = false;
      writeQueueRef.current = writeQueueRef.current.catch(() => undefined).then(async () => {
        if (syncingRef.current || targetVersion <= persistedVersionRef.current) return;
        try {
          const revision = await writeFeedState(
            creatorSnapshot,
            videoSnapshot,
            storageRevisionRef.current,
            writerIdRef.current,
            adoptRevision,
          );
          storageRevisionRef.current = revision;
          persistedVersionRef.current = Math.max(persistedVersionRef.current, targetVersion);
          conflictRevisionRef.current = null;
          channelRef.current?.postMessage({ type: "updated", revision, sender: writerIdRef.current });
          if (persistVersionRef.current <= targetVersion) {
            setStorageStatus(creatorSnapshot.length || videoSnapshot.length ? "ready" : "empty");
            setStorageError(null);
            setIsSaving(false);
          }
        } catch (error) {
          if (error instanceof FeedStorageConflictError) {
            conflictRevisionRef.current = error.actualRevision;
            setStorageStatus("conflict");
            setStorageError("另一个标签页已更新本地数据。请先导出当前内容，再重试保存以确认覆盖。当前内容仍保留在本页。");
            setIsSaving(false);
            return;
          }
          setStorageStatus("write-error");
          setStorageError("本地数据保存失败。请先导出备份，并检查浏览器存储权限或可用空间。");
          setIsSaving(false);
        }
      });
    }, WRITE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [dataAvailable, persistVersion, storageStatus, syncProgress.status]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(STATE_CHANNEL_NAME);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data as { type?: unknown; revision?: unknown; sender?: unknown } | null;
      const revision = Number(message?.revision);
      if (message?.type !== "updated"
        || message.sender === writerIdRef.current
        || !Number.isSafeInteger(revision)
        || revision <= storageRevisionRef.current) return;

      if (syncingRef.current || persistVersionRef.current > persistedVersionRef.current) {
        if (syncingRef.current) {
          dataEpochRef.current += 1;
          abortRef.current?.abort();
        }
        conflictRevisionRef.current = revision;
        setStorageStatus("conflict");
        setStorageError("另一个标签页已更新本地数据，而本页也有未保存修改。请先导出当前内容，再重试保存以确认覆盖。");
        return;
      }

      const epochAtStart = dataEpochRef.current;
      void readFeedState().then((stored) => {
        if (!stored || dataEpochRef.current !== epochAtStart || syncingRef.current) return;
        dataEpochRef.current += 1;
        storageRevisionRef.current = stored.revision;
        creatorsRef.current = stored.creators;
        videosRef.current = stored.videos;
        setCreatorsState(stored.creators);
        setVideosState(stored.videos);
        setDataAvailable(true);
        setStorageStatus(stored.creators.length || stored.videos.length ? "ready" : "empty");
        setStorageError(stored.recoveryMessage ?? null);
        if (stored.needsRewrite) markDirty();
      }).catch(() => {
        setStorageStatus("read-error");
        setStorageError("另一个标签页已更新数据，但本页重新读取失败。当前内容仍保留，请重试读取。");
      });
    };
    return () => {
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [markDirty]);

  const retryHydrate = useCallback(() => {
    setDataAvailable(false);
    setStorageStatus("loading");
    setStorageError(null);
    setHydrateAttempt((attempt) => attempt + 1);
  }, []);

  const retryPersist = useCallback(() => {
    if (!dataAvailable) return;
    if (conflictRevisionRef.current !== null) {
      storageRevisionRef.current = conflictRevisionRef.current;
      conflictRevisionRef.current = null;
    }
    setStorageError(null);
    setStorageStatus(creatorsRef.current.length || videosRef.current.length ? "ready" : "empty");
    markDirty();
  }, [dataAvailable, markDirty]);

  const syncFeed = useCallback(async (requested?: Creator[]) => {
    const runSync = async () => {
      if (syncingRef.current) return false;
      const targets = (requested ?? creatorsRef.current).filter((creator) => creator.enabled);
      if (!targets.length) {
        const runId = runIdRef.current + 1;
        runIdRef.current = runId;
        setSyncProgress({ ...EMPTY_PROGRESS, status: "error", message: "先添加并启用至少一个关注博主", runId });
        return false;
      }

      syncingRef.current = true;
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      const replaceEpochAtStart = dataReplaceEpochRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      failedIdsRef.current = [];

      // Bilibili is paced slowly, so one run covers a slice of its list. When a slice
      // finishes cleanly the run automatically continues with the next slice, so a
      // large following list can be synced with one click instead of one click per slice.
      let round = 0;
      let planned: Creator[] = [];
      let deferred: Creator[] = [];
      let deferredCount = 0;
      let processed = 0;
      let succeeded = 0;
      let failed = 0;
      let skipped = 0;
      let blockedSkipped = 0;
      let emptySnapshotSkipped = 0;
      let incomingCount = 0;
      let blockedPlatforms = new Set<Creator["platform"]>();
      let restrictionRetried = new Set<Creator["platform"]>();
      let skippedCreatorIds: string[] = [];
      let restrictedPlatforms = new Set<Creator["platform"]>();
      let interrupted = false;
      let stateChanged = false;
      let consecutiveProviderFailures = 0;
      let providerInterrupted = false;
      let busyInterrupted = false;
      let bilibiliSessionBlocked = false;
      let sessionChecked = false;
      let cumulativeProcessed = 0;
      let cumulativePlanned = 0;
      let cumulativeSucceeded = 0;
      let cumulativeFailed = 0;
      let cumulativeSkipped = 0;
      let cumulativeBlockedSkipped = 0;
      let cumulativeEmptySkipped = 0;
      let cumulativeIncoming = 0;
      let roundAccumulated = false;

      const applyCreators = (next: Creator[]) => {
        creatorsRef.current = next;
        setCreatorsState(next);
        stateChanged = true;
      };

      const clearErrorsFor = (ids: string[]) => {
        if (!ids.length) return;
        const cleared = clearSyncErrors({ creators: creatorsRef.current, videos: videosRef.current }, ids);
        if (cleared.creators !== creatorsRef.current) applyCreators(cleared.creators);
      };

      const publish = (patch: Partial<SyncProgress>) => {
        setSyncProgress((current) => ({
          ...current,
          ...patch,
          status: patch.status ?? "loading",
          total: cumulativePlanned + (roundAccumulated ? 0 : planned.length),
          processed: cumulativeProcessed + (roundAccumulated ? 0 : processed),
          succeeded: cumulativeSucceeded + (roundAccumulated ? 0 : succeeded),
          failed: cumulativeFailed + (roundAccumulated ? 0 : failed),
          skipped: cumulativeSkipped + (roundAccumulated ? 0 : skipped),
          deferred: deferredCount,
          runId,
        }));
      };

      const beginRound = (nextPlanned: Creator[], nextDeferred: Creator[]) => {
        round += 1;
        planned = nextPlanned;
        deferred = nextDeferred;
        deferredCount = deferred.length;
        processed = 0;
        succeeded = 0;
        failed = 0;
        skipped = 0;
        blockedSkipped = 0;
        emptySnapshotSkipped = 0;
        incomingCount = 0;
        blockedPlatforms = new Set();
        restrictionRetried = new Set();
        skippedCreatorIds = [];
        restrictedPlatforms = new Set();
        interrupted = false;
        providerInterrupted = false;
        busyInterrupted = false;
        consecutiveProviderFailures = 0;
        failedIdsRef.current = [];
        roundAccumulated = false;
      };

      try {
        while (true) {
          const roundTargets = round === 0 ? targets : deferred;
          if (!roundTargets.length) break;
          const limited = applyBilibiliRunLimit(roundTargets);
          beginRound(limited.planned, limited.deferred);
          publish({
            status: "loading",
            message: round === 1 ? `准备同步 ${planned.length} 位博主` : `第 ${round} 轮：继续同步剩余 ${planned.length} 位博主`,
            failedCreatorIds: [],
            skippedCreatorIds: [],
            restrictedPlatforms: [],
          });
        // The sidecar only has the saved cookie; warn before it degrades into a long
        // series of risk-control failures. The probe runs once per sync, not per round.
        if (planned.some((creator) => creator.platform === "bilibili")) {
          if (!sessionChecked) {
            sessionChecked = true;
            publish({ status: "loading", message: "正在检查哔站登录状态" });
            const session = await probeBilibiliSession(controller.signal);
            if (controller.signal.aborted) {
              interrupted = true;
              publish({ status: "error", message: "同步已取消；已有缓存已保留", currentStart: 0, currentEnd: 0 });
              return false;
            }
            // Replacing the whole dataset (import/clear) invalidates this run; ordinary
            // edits during the probe are reconciled per batch instead of aborting.
            if (runIdRef.current !== runId || dataReplaceEpochRef.current !== replaceEpochAtStart) {
              publish({ status: "error", message: "本地数据已被替换，已停止本轮同步", currentStart: 0, currentEnd: 0 });
              return false;
            }
            if (session?.status === "logged-out") {
              bilibiliSessionBlocked = true;
              blockedPlatforms.add("bilibili");
              publish({ message: "哔站 Cookie 已失效，本轮跳过哔站博主；更新 Cookie 后需要重启网站" });
            }
          } else if (bilibiliSessionBlocked) {
            blockedPlatforms.add("bilibili");
          }
        }

        const batches = buildSyncBatches(planned);
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          const plannedBatch = batches[batchIndex];
          if (blockedPlatforms.has(plannedBatch[0].platform)) {
            // Cookie is known to be invalid: skip without requesting and without
            // keeping stale risk-control errors on these records.
            skipped += plannedBatch.length;
            blockedSkipped += plannedBatch.length;
            processed += plannedBatch.length;
            skippedCreatorIds.push(...plannedBatch.map((creator) => creator.id));
            clearErrorsFor(plannedBatch.map((creator) => creator.id));
            publish({ message: "哔站 Cookie 已失效，本轮跳过哔站博主；更新 Cookie 后需要重启网站", skippedCreatorIds: [...skippedCreatorIds] });
            continue;
          }
          if (restrictedPlatforms.has(plannedBatch[0].platform)) {
            skipped += plannedBatch.length;
            processed += plannedBatch.length;
            skippedCreatorIds.push(...plannedBatch.map((creator) => creator.id));
            // A skipped creator was not attempted in this run, so an error from an
            // earlier run must not keep counting as a current failure.
            clearErrorsFor(plannedBatch.map((creator) => creator.id));
            publish({ message: `本轮已跳过访问受限的${plannedBatch[0].platform === "douyin" ? "抖音" : "哔站"}博主`, skippedCreatorIds: [...skippedCreatorIds] });
            continue;
          }
          // The user may pause/unfollow/remove records while this run is walking the
          // plan. Apply results only to records that still exist; never abort the run
          // for a normal edit (only import/clear replaces the dataset).
          const initial = reconcileSyncBatch(plannedBatch, creatorsRef.current);
          if (initial.removed.length) {
            skipped += initial.removed.length;
            processed += initial.removed.length;
            skippedCreatorIds.push(...initial.removed.map((creator) => creator.id));
            publish({ message: `同步期间有 ${initial.removed.length} 位博主被修改，已跳过`, skippedCreatorIds: [...skippedCreatorIds] });
          }
          if (!initial.active.length) continue;
          const batch = initial.active;
          const batchStart = processed + 1;
          const batchEnd = processed + batch.length;
          const currentNames = batch.slice(0, 2).map((creator) => creator.name).join("、");
          const nameSuffix = batch.length > 2 ? "等" : "";
          const hasAnotherDouyinBatch = batch[0]?.platform === "douyin"
            && batches.slice(batchIndex + 1).some((nextBatch) => nextBatch[0]?.platform === "douyin");
          const hasAnotherBilibiliBatch = batch[0]?.platform === "bilibili"
            && batches.slice(batchIndex + 1).some((nextBatch) => nextBatch[0]?.platform === "bilibili");
          publish({ currentStart: batchStart, currentEnd: batchEnd, message: `正在同步第 ${batchStart}-${batchEnd} 位博主：${currentNames}${nameSuffix}` });

          let data;
          try {
            const fetchBatch = async () => {
              const response = await requestSyncBatch(batch, controller.signal, videosRef.current);
              if (!response.configured && !(Array.isArray(response.results) && response.results.length)) {
                throw new Error(response.error || "未配置本机同步服务，请先运行 npm run start:local 完成配置");
              }
              if (!Array.isArray(response.results)) throw new Error(response.error || "同步服务返回的数据不完整");
              return response;
            };
            data = await fetchBatch();
            // A single long-backed-off retry: rate limits are often short-lived, but
            // retrying immediately makes the platform even more suspicious. Creators
            // that already succeeded keep their first result instead of being re-fetched.
            const initialRestricted = getRestrictedSyncPlatform(batch, data);
            if (initialRestricted && !restrictionRetried.has(initialRestricted)) {
              restrictionRetried.add(initialRestricted);
              publish({ message: `${initialRestricted === "douyin" ? "抖音" : "哔站"}访问受限，等待 ${Math.round(RESTRICTION_RETRY_DELAY_MS / 1_000)} 秒后重试一次` });
              await waitWithSignal(RESTRICTION_RETRY_DELAY_MS, controller.signal);
              if (runIdRef.current !== runId || dataReplaceEpochRef.current !== replaceEpochAtStart) {
                interrupted = true;
                break;
              }
              data = mergeRestrictionRetry(data, await fetchBatch());
            }
          } catch (error) {
            if (controller.signal.aborted) {
              interrupted = true;
              break;
            }
            // Another sync (another tab/window) is still running: stop this run instead
            // of marking the batch as a platform failure.
            if (isSyncBusyError(error)) {
              busyInterrupted = true;
              interrupted = true;
              publish({ message: "另一个同步任务正在进行，本轮已停止；请等待它完成后再试" });
              break;
            }
            const message = syncRequestError(error);
            const failedBatch = reconcileSyncBatch(batch, creatorsRef.current);
            const removedNow = failedBatch.removed.length;
            if (removedNow) {
              skipped += removedNow;
              processed += removedNow;
              skippedCreatorIds.push(...failedBatch.removed.map((creator) => creator.id));
            }
            if (failedBatch.active.length) {
              const marked = markBatchFailed({ creators: creatorsRef.current, videos: videosRef.current }, failedBatch.active, message);
              creatorsRef.current = marked.creators;
              setCreatorsState(marked.creators);
              stateChanged = true;
              failed += failedBatch.active.length;
              processed += failedBatch.active.length;
              failedIdsRef.current = Array.from(new Set([...failedIdsRef.current, ...failedBatch.active.map((creator) => creator.id)]));
            }
            const providerFailure = isProviderFailureError(error);
            if (providerFailure) {
              consecutiveProviderFailures += 1;
              if (consecutiveProviderFailures >= MAX_CONSECUTIVE_PROVIDER_FAILURES) {
                // The provider is down: do not label every remaining creator as failed.
                providerInterrupted = true;
                interrupted = true;
                publish({ message: `同步服务连续 ${consecutiveProviderFailures} 次请求失败，已停止本轮同步；剩余博主未标记为失败，可直接重试` });
                break;
              }
            } else {
              consecutiveProviderFailures = 0;
            }
            publish({ message: `第 ${batchStart}-${batchEnd} 位同步失败，继续处理后续博主` });
            if (hasAnotherDouyinBatch) {
              await waitWithSignal(getDouyinCooldownMs(), controller.signal);
            } else if (hasAnotherBilibiliBatch) {
              await waitWithSignal(getBilibiliCooldownMs(), controller.signal);
            }
            continue;
          }

          if (controller.signal.aborted || runIdRef.current !== runId || dataReplaceEpochRef.current !== replaceEpochAtStart) {
            interrupted = true;
            break;
          }
          // Reconcile again: records can be paused/removed while the request ran.
          const current = reconcileSyncBatch(batch, creatorsRef.current);
          if (current.removed.length) {
            skipped += current.removed.length;
            processed += current.removed.length;
            skippedCreatorIds.push(...current.removed.map((creator) => creator.id));
          }
          if (!current.active.length) continue;
          const applyBatch = current.active;

          const merged = mergeSyncResponse({ creators: creatorsRef.current, videos: videosRef.current }, applyBatch, data);
          creatorsRef.current = merged.creators;
          videosRef.current = merged.videos;
          setCreatorsState(merged.creators);
          setVideosState(merged.videos);
          stateChanged = true;
          const batchFailed = merged.failedCreatorIds.length;
          const emptySkipped = merged.emptySnapshotCreatorIds.length;
          failed += batchFailed;
          skipped += emptySkipped;
          emptySnapshotSkipped += emptySkipped;
          succeeded += applyBatch.length - batchFailed - emptySkipped;
          processed += applyBatch.length;
          incomingCount += merged.incomingCount;
          failedIdsRef.current = Array.from(new Set([...failedIdsRef.current, ...merged.failedCreatorIds]));
          if (emptySkipped) {
            skippedCreatorIds.push(...merged.emptySnapshotCreatorIds);
            clearErrorsFor(merged.emptySnapshotCreatorIds);
          }
          const restrictedPlatform = getRestrictedSyncPlatform(applyBatch, data);
          if (restrictedPlatform) restrictedPlatforms.add(restrictedPlatform);
          // Several "complete but empty" answers in one batch mean rate limiting; stop
          // this platform for the run and keep the old caches instead of counting failures.
          const emptyRestricted = merged.suspiciousEmptySnapshot ? applyBatch[0]?.platform : null;
          if (emptyRestricted) restrictedPlatforms.add(emptyRestricted);
          if (isProviderUnavailableFailure(data)) {
            consecutiveProviderFailures += 1;
            if (consecutiveProviderFailures >= MAX_CONSECUTIVE_PROVIDER_FAILURES) {
              providerInterrupted = true;
              interrupted = true;
              publish({ message: `同步服务连续 ${consecutiveProviderFailures} 次不可用，已停止本轮同步；剩余博主未标记为失败，可直接重试` });
              break;
            }
          } else {
            consecutiveProviderFailures = 0;
          }
          publish({
            message: restrictedPlatform || emptyRestricted
              ? `${(restrictedPlatform ?? emptyRestricted) === "douyin" ? "抖音" : "哔站"}触发访问限制，已停止该平台后续请求${emptySkipped ? `；${emptySkipped} 位返回 0 条投稿，已保留旧缓存` : ""}`
              : `已处理 ${processed}/${planned.length} 位博主，读取 ${incomingCount} 条视频`,
            restrictedPlatforms: Array.from(restrictedPlatforms),
          });
          if (hasAnotherDouyinBatch && !restrictedPlatform) {
            await waitWithSignal(getDouyinCooldownMs(), controller.signal);
          } else if (hasAnotherBilibiliBatch && !restrictedPlatform) {
            await waitWithSignal(getBilibiliCooldownMs(), controller.signal);
          }
        }

        if (interrupted) {
          const message = busyInterrupted
            ? "另一个同步任务正在进行，本轮已停止；请等待它完成后再试"
            : providerInterrupted
              ? `同步服务连续 ${consecutiveProviderFailures} 次失败或不稳定，已停止本轮同步；未处理的博主可直接重试`
              : controller.signal.aborted
                ? "同步已取消；已有缓存已保留"
                : dataReplaceEpochRef.current !== replaceEpochAtStart
                  ? "本地数据已被替换，已停止应用后续结果"
                  : "数据在同步期间发生变化，已停止应用后续结果";
          const status: SyncStatus = cumulativeSucceeded + succeeded > 0 && cumulativeProcessed + processed > 0
            ? "partial"
            : "error";
          publish({
            status,
            message,
            currentStart: 0,
            currentEnd: 0,
            failedCreatorIds: failedIdsRef.current,
            skippedCreatorIds,
            restrictedPlatforms: Array.from(restrictedPlatforms),
          });
          return false;
        }

        cumulativeProcessed += processed;
        cumulativePlanned += planned.length;
        cumulativeSucceeded += succeeded;
        cumulativeFailed += failed;
        cumulativeSkipped += skipped;
        cumulativeBlockedSkipped += blockedSkipped;
        cumulativeEmptySkipped += emptySnapshotSkipped;
        cumulativeIncoming += incomingCount;
        roundAccumulated = true;

        const runValid = !controller.signal.aborted
          && runIdRef.current === runId
          && dataReplaceEpochRef.current === replaceEpochAtStart;
        if (shouldAutoContinueSync({
          round,
          maxRounds: MAX_AUTO_SYNC_ROUNDS,
          deferred: deferredCount,
          failed: cumulativeFailed,
          emptySkipped: cumulativeEmptySkipped,
          bilibiliBlocked: bilibiliSessionBlocked,
          restricted: restrictedPlatforms.size,
          aborted: controller.signal.aborted,
          runValid,
        })) {
          publish({
            status: "loading",
            message: `第 ${round} 轮完成；${Math.round(AUTO_SYNC_CONTINUE_DELAY_MS / 1_000)} 秒后自动继续剩余 ${deferredCount} 位哔站博主（第 ${round + 1} 轮）`,
            currentStart: 0,
            currentEnd: 0,
            failedCreatorIds: [],
            skippedCreatorIds: [],
          });
          try {
            await waitWithSignal(AUTO_SYNC_CONTINUE_DELAY_MS, controller.signal);
          } catch {
            publish({ status: "error", message: "同步已取消；已有缓存已保留", currentStart: 0, currentEnd: 0 });
            return false;
          }
          if (!runValid || runIdRef.current !== runId) {
            publish({ status: "error", message: "同步已停止；已有缓存已保留", currentStart: 0, currentEnd: 0 });
            return false;
          }
          continue;
        }

        const restrictionSkipped = cumulativeSkipped - cumulativeBlockedSkipped - cumulativeEmptySkipped;
        const status = computeSyncStatus({
          failed: cumulativeFailed,
          succeeded: cumulativeSucceeded,
          skipped: cumulativeSkipped,
          deferred: deferredCount,
        });
        const parts: string[] = [];
        if (round > 1) parts.push(`分 ${round} 轮完成`);
        if (cumulativeIncoming > 0) parts.push(`读取 ${cumulativeIncoming} 条视频`);
        if (bilibiliSessionBlocked) {
          parts.push("哔站 Cookie 已失效，本轮未请求哔站博主；请重新运行 setup-sidecar.ps1 更新 Cookie 并重启网站后重试");
        }
        if (restrictionSkipped > 0) {
          parts.push(`平台访问受限，本轮跳过 ${restrictionSkipped} 位博主，稍后可重试`);
        } else if (restrictedPlatforms.size > 0 && cumulativeEmptySkipped === 0) {
          parts.push(`平台访问受限（${[...restrictedPlatforms].map((platform) => platform === "douyin" ? "抖音" : "哔站").join("、")}），稍后可重试`);
        }
        if (cumulativeEmptySkipped > 0) {
          parts.push(`${cumulativeEmptySkipped} 位博主返回 0 条投稿，已保留旧缓存（可能触发平台限流），稍后重试`);
        }
        if (deferredCount > 0) {
          parts.push(`哔站单轮最多同步 ${MAX_BILIBILI_CREATORS_PER_RUN} 位，剩余 ${deferredCount} 位将在下次同步继续`);
        }
        if (cumulativeFailed > 0) parts.push(`${cumulativeFailed} 位博主同步失败，可重试`);
        const message = parts.length ? parts.join("；") : `同步完成，读取 ${cumulativeIncoming} 条视频`;
        publish({
          status,
          message,
          currentStart: 0,
          currentEnd: 0,
          failedCreatorIds: failedIdsRef.current,
          skippedCreatorIds,
          restrictedPlatforms: Array.from(restrictedPlatforms),
        });
        return cumulativeFailed === 0 && !bilibiliSessionBlocked;
        }
        return false;
      } catch (error) {
        const message = syncRequestError(error);
        publish({
          status: cumulativeSucceeded + succeeded > 0 ? "partial" : "error",
          message,
          currentStart: 0,
          currentEnd: 0,
          restrictedPlatforms: Array.from(restrictedPlatforms),
        });
        return false;
      } finally {
        syncingRef.current = false;
        abortRef.current = null;
        if (stateChanged) markDirty();
      }
    };

    if (typeof navigator === "undefined" || !("locks" in navigator)) return runSync();
    return navigator.locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (lock) return runSync();
      // A second click inside this tab must not abort the run already in progress.
      if (syncingRef.current) return false;
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      setSyncProgress({ ...EMPTY_PROGRESS, status: "error", message: "另一个标签页正在同步，请稍后重试", runId });
      return false;
    });
  }, [markDirty]);

  useEffect(() => {
    if (!dataAvailable || (storageStatus !== "ready" && storageStatus !== "empty")) return;
    const newlyAdded = creatorsRef.current.filter((creator) => !autoSyncSeenIdsRef.current.has(creator.id));
    newlyAdded.forEach((creator) => autoSyncSeenIdsRef.current.add(creator.id));
    if (!autoSyncStartedRef.current) {
      // Empty and fully paused lists leave the first automatic run available.
      if (!creatorsRef.current.some((creator) => creator.enabled)) return;
      autoSyncStartedRef.current = true;
      // A previous rate-limit error must not disable automatic sync forever: the run
      // stops itself on the first restriction and skipped records are not re-labeled.
      void syncFeed();
      return;
    }

    newlyAdded.filter((creator) => creator.enabled).forEach((creator) => pendingAutoSyncIdsRef.current.add(creator.id));
    if (syncingRef.current || !pendingAutoSyncIdsRef.current.size) return;
    const targets = creatorsRef.current.filter((creator) => creator.enabled && pendingAutoSyncIdsRef.current.has(creator.id));
    pendingAutoSyncIdsRef.current.clear();
    if (targets.length) void syncFeed(targets);
  }, [creators, dataAvailable, storageStatus, syncProgress.status, syncFeed]);

  const cancelSync = useCallback(() => {
    if (!syncingRef.current) return;
    abortRef.current?.abort();
  }, []);

  const retryFailed = useCallback(() => {
    // Prefer the stored errors so the action also works after a page reload, when
    // the in-memory list of the last run is gone.
    const ids = new Set(failedIdsRef.current);
    const targets = creatorsRef.current.filter((creator) => (
      creator.enabled && (ids.has(creator.id) || Boolean(creator.syncError))
    ));
    if (!targets.length) {
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      // Do not report success for a no-op: the reported failures are paused/removed.
      setSyncProgress({
        ...EMPTY_PROGRESS,
        status: "partial",
        message: "没有可重试的博主（报错的博主已暂停或已取消关注）",
        runId,
      });
      return Promise.resolve(false);
    }
    return syncFeed(targets);
  }, [syncFeed]);

  const syncStatus = syncProgress.status;
  const value = useMemo<FeedContextValue>(() => ({
    creators,
    videos,
    isHydrated: storageStatus !== "loading",
    dataAvailable,
    storageStatus,
    storageError,
    isSaving,
    setCreators,
    setVideos,
    getDataEpoch,
    replaceState,
    retryHydrate,
    retryPersist,
    syncStatus,
    syncState: syncStatus,
    syncProgress,
    syncMessage: syncProgress.message,
    syncFeed,
    cancelSync,
    retryFailed,
  }), [
    cancelSync,
    creators,
    dataAvailable,
    getDataEpoch,
    replaceState,
    retryFailed,
    retryHydrate,
    retryPersist,
    setCreators,
    setVideos,
    storageError,
    storageStatus,
    isSaving,
    syncFeed,
    syncProgress,
    syncStatus,
    videos,
  ]);

  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

export function useFeed(): FeedContextValue {
  const context = useContext(FeedContext);
  if (!context) throw new Error("useFeed 必须在 FeedProvider 内使用");
  return context;
}
