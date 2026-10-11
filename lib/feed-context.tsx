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
  markBatchFailed,
  mergeSyncResponse,
  buildSyncBatches,
  getDouyinCooldownMs,
  requestSyncBatch,
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
  currentStart: 0,
  currentEnd: 0,
  message: "",
  failedCreatorIds: [],
  runId: 0,
};

function readLegacyState(): { state: FeedState | null; failed: boolean; recoveryMessage?: string } {
  try {
    const creatorsValue = window.localStorage.getItem(LEGACY_CREATOR_STORAGE_KEY);
    const videosValue = window.localStorage.getItem(LEGACY_VIDEO_STORAGE_KEY);
    if (creatorsValue === null && videosValue === null) return { state: null, failed: false };
    const recovered = recoverFeedState({
      version: 1,
      creators: JSON.parse(creatorsValue ?? "null"),
      videos: JSON.parse(videosValue ?? "null"),
    });
    return {
      state: recovered?.state ?? null,
      failed: !recovered,
      ...(recovered?.repaired ? { recoveryMessage: `已从旧版缓存隔离或修复 ${recovered.repaired} 条异常数据记录。` } : {}),
    };
  } catch {
    return { state: null, failed: true };
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
  const persistVersionRef = useRef(0);
  const persistedVersionRef = useRef(0);
  const storageRevisionRef = useRef(0);
  const conflictRevisionRef = useRef<number | null>(null);
  const writerIdRef = useRef("");
  const channelRef = useRef<BroadcastChannel | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const syncingRef = useRef(false);
  const autoSyncStartedRef = useRef(false);
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
    dataEpochRef.current += 1;
    const next = typeof update === "function" ? update(creatorsRef.current) : update;
    creatorsRef.current = next;
    setCreatorsState(next);
    markDirty();
  }, [markDirty]);

  const setVideos = useCallback<Dispatch<SetStateAction<VideoItem[]>>>((update) => {
    dataEpochRef.current += 1;
    const next = typeof update === "function" ? update(videosRef.current) : update;
    videosRef.current = next;
    setVideosState(next);
    markDirty();
  }, [markDirty]);

  const replaceState = useCallback((next: FeedState) => {
    dataEpochRef.current += 1;
    creatorsRef.current = next.creators;
    videosRef.current = next.videos;
    setCreatorsState(next.creators);
    setVideosState(next.videos);
    setDataAvailable(true);
    setStorageStatus("ready");
    setStorageError(null);
    conflictRevisionRef.current = null;
    markDirty();
  }, [markDirty]);

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
      try {
        const stored = await readFeedState();
        if (stored) {
          state = { version: 2, creators: stored.creators, videos: stored.videos };
          revision = stored.revision;
          needsRewrite = Boolean(stored.needsRewrite);
          recoveryMessage = stored.recoveryMessage;
        }
      } catch {
        databaseFailed = true;
      }

      if (!state) {
        const legacy = readLegacyState();
        state = legacy.state;
        usedLegacyStorage = Boolean(state);
        recoveryMessage = legacy.recoveryMessage;
        databaseFailed = databaseFailed || legacy.failed;
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
        setStorageError(recoveryMessage ?? null);
        if (needsRewrite || usedLegacyStorage) markDirty();
        return;
      }

      if (databaseFailed) {
        setDataAvailable(false);
        setStorageStatus("read-error");
        setStorageError("本地数据读取失败。请重试，或导入之前导出的备份；当前缓存不会被覆盖。");
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
      writeQueueRef.current = writeQueueRef.current.catch(() => undefined).then(async () => {
        if (syncingRef.current || targetVersion <= persistedVersionRef.current) return;
        try {
          const revision = await writeFeedState(
            creatorSnapshot,
            videoSnapshot,
            storageRevisionRef.current,
            writerIdRef.current,
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
      const epochAtStart = dataEpochRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      failedIdsRef.current = [];
      let processed = 0;
      let succeeded = 0;
      let failed = 0;
      let incomingCount = 0;
      let interrupted = false;
      let stateChanged = false;

      const publish = (patch: Partial<SyncProgress>) => {
        setSyncProgress((current) => ({
          ...current,
          ...patch,
          status: patch.status ?? "loading",
          total: targets.length,
          processed,
          succeeded,
          failed,
          runId,
        }));
      };

      publish({ status: "loading", message: `准备同步 ${targets.length} 位博主`, failedCreatorIds: [] });

      try {
        const batches = buildSyncBatches(targets);
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          const batch = batches[batchIndex];
          const batchStart = processed + 1;
          const batchEnd = processed + batch.length;
          const currentNames = batch.slice(0, 2).map((creator) => creator.name).join("、");
          const nameSuffix = batch.length > 2 ? "等" : "";
          const hasAnotherDouyinBatch = batch[0]?.platform === "douyin"
            && batches.slice(batchIndex + 1).some((nextBatch) => nextBatch[0]?.platform === "douyin");
          publish({ currentStart: batchStart, currentEnd: batchEnd, message: `正在同步第 ${batchStart}-${batchEnd} 位博主：${currentNames}${nameSuffix}` });

          let data;
          try {
            data = await requestSyncBatch(batch, controller.signal, videosRef.current);
            if (!data.configured) throw new Error(data.error || "未配置本机抓取服务，请先运行 npm run start:local");
            if (!Array.isArray(data.results)) throw new Error(data.error || "同步服务返回的数据不完整");
          } catch (error) {
            if (controller.signal.aborted) {
              interrupted = true;
              break;
            }
            const message = syncRequestError(error);
            if (dataEpochRef.current === epochAtStart && runIdRef.current === runId) {
              const marked = markBatchFailed({ creators: creatorsRef.current, videos: videosRef.current }, batch, message);
              creatorsRef.current = marked.creators;
              setCreatorsState(marked.creators);
              stateChanged = true;
            }
            failed += batch.length;
            processed += batch.length;
            failedIdsRef.current = Array.from(new Set([...failedIdsRef.current, ...batch.map((creator) => creator.id)]));
            publish({ message: `第 ${batchStart}-${batchEnd} 位同步失败，继续处理后续博主` });
            if (hasAnotherDouyinBatch) {
              await waitWithSignal(getDouyinCooldownMs(), controller.signal);
            }
            continue;
          }

          if (controller.signal.aborted || runIdRef.current !== runId || dataEpochRef.current !== epochAtStart) {
            interrupted = true;
            break;
          }

          const merged = mergeSyncResponse({ creators: creatorsRef.current, videos: videosRef.current }, batch, data);
          creatorsRef.current = merged.creators;
          videosRef.current = merged.videos;
          setCreatorsState(merged.creators);
          setVideosState(merged.videos);
          stateChanged = true;
          const batchFailed = merged.failedCreatorIds.length;
          failed += batchFailed;
          succeeded += batch.length - batchFailed;
          processed += batch.length;
          incomingCount += merged.incomingCount;
          failedIdsRef.current = Array.from(new Set([...failedIdsRef.current, ...merged.failedCreatorIds]));
          publish({ message: `已处理 ${processed}/${targets.length} 位博主，读取 ${incomingCount} 条视频` });
          if (hasAnotherDouyinBatch) {
            await waitWithSignal(getDouyinCooldownMs(), controller.signal);
          }
        }

        if (interrupted) {
          const message = controller.signal.aborted ? "同步已取消；已有缓存已保留" : "数据在同步期间发生变化，已停止应用后续结果";
          const status: SyncStatus = controller.signal.aborted && processed > 0 ? "partial" : "error";
          publish({ status, message, currentStart: 0, currentEnd: 0 });
          return false;
        }

        const status: SyncStatus = failed === 0 ? "success" : succeeded > 0 ? "partial" : "error";
        const message = failed === 0
          ? `同步完成，读取 ${incomingCount} 条视频`
          : `${succeeded ? `已读取 ${incomingCount} 条，` : ""}${failed} 位博主同步失败，可在关注列表重试`;
        publish({ status, message, currentStart: 0, currentEnd: 0, failedCreatorIds: failedIdsRef.current });
        return failed === 0;
      } catch (error) {
        const message = syncRequestError(error);
        publish({ status: processed ? "partial" : "error", message, currentStart: 0, currentEnd: 0 });
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
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      setSyncProgress({ ...EMPTY_PROGRESS, status: "error", message: "另一个标签页正在同步，请稍后重试", runId });
      return false;
    });
  }, [markDirty]);

  useEffect(() => {
    if (autoSyncStartedRef.current) return;
    if (!dataAvailable || (storageStatus !== "ready" && storageStatus !== "empty")) return;

    autoSyncStartedRef.current = true;
    if (!creatorsRef.current.some((creator) => creator.enabled)) return;
    void syncFeed();
  }, [dataAvailable, storageStatus, syncFeed]);

  const cancelSync = useCallback(() => {
    if (!syncingRef.current) return;
    abortRef.current?.abort();
  }, []);

  const retryFailed = useCallback(() => {
    const ids = new Set(failedIdsRef.current);
    const targets = creatorsRef.current.filter((creator) => ids.has(creator.id) && creator.enabled);
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
