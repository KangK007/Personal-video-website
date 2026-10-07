"use client";

import {
  ArrowLeft,
  ArrowUpRight,
  ArrowsClockwise,
  CalendarBlank,
  Check,
  CheckCircle,
  CircleNotch,
  CloudArrowDown,
  CloudArrowUp,
  FilmSlate,
  GearSix,
  Info,
  List,
  ListPlus,
  MagnifyingGlass,
  Monitor,
  Moon,
  Plus,
  SlidersHorizontal,
  SquaresFour,
  StopCircle,
  Sun,
  Trash,
  UserCirclePlus,
  Warning,
  X,
  XCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { createPortal } from "react-dom";
import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  detectPlatform,
  formatCount,
  formatDate,
  formatDateTime,
  formatLongDate,
  MAX_CREATOR_IMPORT_LINES,
  normalizeUrl,
  parseCreatorLines,
  platformClass,
  platformLabel,
  type CreatorDraft,
} from "@/components/video-hub/helpers";
import { useFeed } from "@/lib/feed-context";
import { creatorLatestTimestamp, isRecentVideo, parsePublishedAt, platformMatches, sortVideos, videoTimestamp, VISIBLE_VIDEO_BATCH_SIZE } from "@/lib/feed-logic";
import { getFeedCreatorIdentityKey, getFeedVideoIdentityKey, isPlatformProfileUrl, isPlatformVideoUrl, MAX_BACKUP_FILE_BYTES, MAX_FEED_CREATORS, MAX_FEED_TITLE_LENGTH, MAX_FEED_URL_LENGTH, migrateFeedState } from "@/lib/feed-storage";
import { useNotice, type NoticeInput } from "@/lib/notice-context";
import { useUiPreferences, type UiTheme, type VideoView } from "@/lib/ui-preferences";
import type { Creator, FeedState, Platform, VideoItem } from "@/lib/feed-types";

type PlatformFilter = "all" | Platform;
type HubView = "recent" | "following";
type CreatorStatusFilter = "all" | "unsynced" | "failed" | "paused";
type FrameProps = { openCreator: () => void; openVideo: () => void; settingsOpen: boolean; setSettingsOpen: (open: boolean) => void; onExport: () => void; onImport: () => void; onClear: () => void };

const DAY_MS = 86_400_000;

function getInitials(name: string) {
  return name.trim().slice(0, 1) || "关";
}

function makeId(prefix: string) {
  return `${prefix}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function removeSavedVideo(
  video: VideoItem,
  setVideos: Dispatch<SetStateAction<VideoItem[]>>,
  showNotice: (input: NoticeInput, duration?: number) => string,
  clearNotice: (id?: string) => void,
) {
  const videoKey = getFeedVideoIdentityKey(video.videoUrl, video.platform);
  setVideos((current) => current.filter((entry) => entry.id !== video.id));

  let noticeId = "";
  const undo = () => {
    setVideos((current) => current.some((entry) => (
      entry.id === video.id
      || getFeedVideoIdentityKey(entry.videoUrl, entry.platform) === videoKey
    )) ? current : [...current, video]);
    clearNotice(noticeId);
  };

  noticeId = showNotice({
    kind: "success",
    text: "已移除本地保存的视频",
    action: { label: "撤销", onClick: undo },
  }, 10_000);
}

function creatorLatest(creator: Creator, videos: VideoItem[]) {
  return creatorLatestTimestamp(creator, videos);
}

function useDialogA11y(open: boolean, onClose: () => void, dialogRef: RefObject<HTMLElement | null>, initialFocusRef?: RefObject<HTMLElement | null>) {
  const onCloseRef = useRef(onClose);
  const initialFocusRefRef = useRef(initialFocusRef);
  useEffect(() => {
    onCloseRef.current = onClose;
    initialFocusRefRef.current = initialFocusRef;
  }, [initialFocusRef, onClose]);
  useEffect(() => {
    if (!open) return undefined;
    const restore = document.activeElement as HTMLElement | null;
    const appShell = document.querySelector<HTMLElement>(".app-shell");
    appShell?.setAttribute("inert", "");
    const focusInitial = () => (initialFocusRefRef.current?.current ?? dialogRef.current?.querySelector<HTMLElement>("button, input, textarea, select, a[href]"))?.focus();
    const timer = window.setTimeout(focusInitial, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      appShell?.removeAttribute("inert");
      window.requestAnimationFrame(() => {
        if (restore?.isConnected) {
          restore.focus();
        } else {
          document.querySelector<HTMLElement>("#main-content h1, #main-content")?.focus();
        }
      });
    };
  }, [dialogRef, open]);
}

function Modal({ title, description, onClose, children, initialFocusRef, className = "" }: { title: string; description: string; onClose: () => void; children: ReactNode; initialFocusRef?: RefObject<HTMLElement | null>; className?: string }) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useDialogA11y(true, onClose, dialogRef, initialFocusRef);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="modal-layer" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <div className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭窗口" title="关闭">
            <X size={20} weight="bold" aria-hidden="true" />
          </button>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  );
}

function Avatar({ creator, size = "normal" }: { creator: Creator; size?: "normal" | "large" }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = Boolean(creator.avatarUrl && failedUrl === creator.avatarUrl);
  const className = `creator-avatar ${size === "large" ? "creator-avatar-large" : ""} ${platformClass(creator.platform)}`;
  if (creator.avatarUrl && !failed) {
    // Platform CDN hosts vary; loading them directly avoids proxying arbitrary remote URLs.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={creator.avatarUrl} alt="" className={className} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(creator.avatarUrl ?? "")} />;
  }
  return <span className={className} aria-hidden="true">{getInitials(creator.name)}</span>;
}

function VideoCover({ video }: { video: VideoItem }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = Boolean(video.coverUrl && failedUrl === video.coverUrl);
  if (video.coverUrl && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={video.coverUrl} alt={`${video.title}的封面`} className="video-cover" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedUrl(video.coverUrl ?? "")} />;
  }
  return <div className={`cover-fallback ${platformClass(video.platform)}`} aria-label="封面不可用"><FilmSlate size={34} weight="duotone" aria-hidden="true" /></div>;
}

function VideoCard({ video, creator, view, onDelete }: { video: VideoItem; creator: Creator; view: VideoView; onDelete?: (video: VideoItem) => void }) {
  const label = platformLabel(video.platform);
  return (
    <article className={`video-card ${view === "list" ? "is-list" : ""}`}>
      <a className="cover-wrap" href={video.videoUrl} target="_blank" rel="noreferrer" aria-label={`在${label}打开：${video.title}`}>
        <VideoCover video={video} />
        {video.duration ? <span className="duration">{video.duration}</span> : null}
      </a>
      {onDelete ? <button className="card-delete" type="button" onClick={() => onDelete(video)} aria-label={`删除手动保存的视频：${video.title}`} title="删除视频"><Trash size={16} aria-hidden="true" /></button> : null}
      <div className="video-card-body">
        <div className="video-meta-top"><span className={`platform-label ${platformClass(video.platform)}`}><span className="platform-mark" aria-hidden="true" />{label}</span><span className={!parsePublishedAt(video.publishedAt) ? "unknown-date" : ""}>{formatDate(video.publishedAt)}</span></div>
        <h3 className="video-title"><a href={video.videoUrl} target="_blank" rel="noreferrer" aria-label={`在${label}打开：${video.title}`}>{video.title}</a></h3>
        <div className="video-card-footer">
          <Link href={`/creator/${creator.id}`} className="creator-chip creator-link" aria-label={`查看${creator.name}的个人页`}><Avatar creator={creator} /><span>{creator.name}</span><ArrowUpRight size={14} aria-hidden="true" /></Link>
        </div>
      </div>
    </article>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="search-box">
      <MagnifyingGlass size={18} aria-hidden="true" />
      <span className="visually-hidden">{placeholder}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && value) { event.preventDefault(); onChange(""); } }} placeholder={placeholder} type="search" />
      {value ? <button type="button" className="search-clear" onClick={() => onChange("")} aria-label="清除搜索" title="清除搜索"><XCircle size={18} aria-hidden="true" /></button> : null}
    </label>
  );
}

function PlatformTabs({ value, onChange, counts }: { value: PlatformFilter; onChange: (value: PlatformFilter) => void; counts: Record<PlatformFilter, number> }) {
  return <div className="platform-tabs" role="group" aria-label="平台筛选">{(["all", "douyin", "bilibili"] as const).map((key) => <button key={key} type="button" className={value === key ? "is-active" : ""} aria-pressed={value === key} onClick={() => onChange(key)}><span>{key === "all" ? "全部" : platformLabel(key)}</span><b>{formatCount(counts[key])}</b></button>)}</div>;
}

function ViewModeToggle({ value, onChange }: { value: VideoView; onChange: (value: VideoView) => void }) {
  return <div className="view-toggle" role="group" aria-label="视频视图"><button type="button" className={value === "grid" ? "is-active" : ""} aria-pressed={value === "grid"} onClick={() => onChange("grid")} title="网格视图" aria-label="网格视图"><SquaresFour size={18} aria-hidden="true" /></button><button type="button" className={value === "list" ? "is-active" : ""} aria-pressed={value === "list"} onClick={() => onChange("list")} title="列表视图" aria-label="列表视图"><List size={18} aria-hidden="true" /></button></div>;
}

function StatusTabs({ value, onChange, counts }: { value: CreatorStatusFilter; onChange: (value: CreatorStatusFilter) => void; counts: Record<CreatorStatusFilter, number> }) {
  const labels: Record<CreatorStatusFilter, string> = { all: "全部", unsynced: "未同步", failed: "同步失败", paused: "已暂停" };
  return <div className="status-tabs" role="group" aria-label="关注状态筛选">{(["all", "unsynced", "failed", "paused"] as const).map((key) => <button key={key} type="button" className={value === key ? "is-active" : ""} aria-pressed={value === key} onClick={() => onChange(key)}>{labels[key]}<b>{formatCount(counts[key])}</b></button>)}</div>;
}

function LoadingState() {
  return <div className="loading-state" role="status" aria-label="正在读取本地数据"><span className="loading-bar" /><span className="loading-bar short" /><div className="loading-grid">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div></div>;
}

function StorageRecovery({ message, onRetry, onImport }: { message: string; onRetry: () => void; onImport: () => void }) {
  return <section className="recovery-state" role="alert"><span className="empty-icon"><Warning size={28} weight="duotone" aria-hidden="true" /></span><h2>本地数据暂时无法读取</h2><p>{message}</p><div className="modal-actions"><button className="secondary-button" type="button" onClick={onRetry}><ArrowsClockwise size={18} aria-hidden="true" />重试读取</button><button className="primary-button" type="button" onClick={onImport}><CloudArrowDown size={18} aria-hidden="true" />导入备份</button></div></section>;
}

function StorageWriteRecovery({ message, onRetry, onExport, conflict = false }: { message: string; onRetry: () => void; onExport: () => void; conflict?: boolean }) {
  return <section className="recovery-state" role="alert"><span className="empty-icon"><Warning size={28} weight="duotone" aria-hidden="true" /></span><h2>本地数据暂时无法保存</h2><p>{message}</p><div className="modal-actions"><button className="secondary-button" type="button" onClick={onExport}><CloudArrowUp size={18} aria-hidden="true" />先导出备份</button><button className="primary-button" type="button" onClick={onRetry}><ArrowsClockwise size={18} aria-hidden="true" />{conflict ? "确认覆盖并保存" : "重试保存"}</button></div></section>;
}

type EmptyKind = "no-creators" | "no-recent" | "no-platform" | "no-videos" | "no-match" | "no-following-match";

function EmptyState({ kind, onAdd, onSync, onClear, query, platform }: { kind: EmptyKind; onAdd: () => void; onSync: () => void; onClear?: () => void; query?: string; platform?: PlatformFilter }) {
  const copy: Record<EmptyKind, [string, string]> = {
    "no-creators": ["还没有关注博主", "添加抖音或哔站主页后，这里会成为你的专属视频收件箱。"],
    "no-recent": ["最近 7 天没有更新", "同步一次关注流，或者稍后再回来看看。"],
    "no-platform": ["这个平台最近没有更新", "换个平台筛选，或检查关注列表里的同步状态。"],
    "no-videos": ["还没有本地视频", "同步这个博主即可拉取全部可见投稿。"],
    "no-match": ["没有匹配结果", `未找到${query ? `“${query}”` : "相关"}${platform && platform !== "all" ? ` · ${platformLabel(platform)}` : ""}。`],
    "no-following-match": ["没有匹配的关注博主", `当前筛选${query ? `“${query}”` : ""}下没有结果。`],
  };
  const [title, description] = copy[kind];
  return <div className="empty-state"><span className="empty-icon" aria-hidden="true"><FilmSlate size={30} weight="duotone" /></span><h3>{title}</h3><p>{description}</p><div className="empty-actions">{kind === "no-creators" ? <button className="primary-button" type="button" onClick={onAdd}><Plus size={18} aria-hidden="true" />添加博主</button> : null}{kind === "no-recent" || kind === "no-platform" || kind === "no-videos" ? <button className="secondary-button" type="button" onClick={onSync}><ArrowsClockwise size={18} aria-hidden="true" />同步关注流</button> : null}{(kind === "no-match" || kind === "no-following-match") && onClear ? <button className="secondary-button" type="button" onClick={onClear}>清除筛选</button> : null}</div></div>;
}

function PageHeader({ eyebrow, title, subtitle, stat, action }: { eyebrow: string; title: string; subtitle: string; stat: string; action?: ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-subtitle">{subtitle}</p></div><div className="page-header-side">{action}<span className="page-stat">{stat}</span></div></header>;
}

function SyncProgress({ compact = false }: { compact?: boolean }) {
  const { syncProgress, syncStatus, cancelSync, retryFailed } = useFeed();
  if (syncStatus === "idle") return null;
  const percent = syncProgress.total ? Math.min(100, Math.round((syncProgress.processed / syncProgress.total) * 100)) : 0;
  return <div className={`sync-progress ${compact ? "is-compact" : ""} sync-${syncStatus}`} role={compact ? undefined : "status"} aria-live={compact ? "off" : "polite"}><div className="sync-progress-top"><span className="sync-progress-label">{syncStatus === "loading" ? <CircleNotch className="spin" size={16} aria-hidden="true" /> : syncStatus === "success" ? <CheckCircle size={16} aria-hidden="true" /> : <Warning size={16} aria-hidden="true" />}{syncProgress.message || "同步状态"}</span>{syncStatus === "loading" ? <button className="text-button" type="button" onClick={cancelSync}><StopCircle size={16} aria-hidden="true" />取消同步</button> : syncProgress.failed > 0 ? <button className="text-button" type="button" onClick={() => void retryFailed()}><ArrowsClockwise size={16} aria-hidden="true" />仅重试失败</button> : null}</div>{syncProgress.total > 0 ? <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={syncProgress.total} aria-valuenow={syncProgress.processed} aria-label="同步进度"><span style={{ transform: `scaleX(${percent / 100})` }} /></div> : null}<div className="sync-progress-meta">{syncProgress.total ? <span>{syncProgress.processed}/{syncProgress.total} 位博主 · 成功 {syncProgress.succeeded} · 失败 {syncProgress.failed}</span> : null}{syncProgress.currentStart ? <span>当前第 {syncProgress.currentStart}-{syncProgress.currentEnd} 位</span> : null}</div></div>;
}

function NoticeHost() {
  const { notice, clearNotice } = useNotice();
  if (!notice) return null;
  return <div className={`notice notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} aria-live="polite"><span className="notice-icon" aria-hidden="true">{notice.kind === "success" ? <Check size={18} /> : notice.kind === "error" ? <Warning size={18} /> : <Info size={18} />}</span><span className="notice-text">{notice.text}</span>{notice.action ? <button className="notice-action" type="button" onClick={notice.action.onClick}>{notice.action.label}</button> : null}<button className="notice-close" type="button" onClick={() => clearNotice(notice.id)} aria-label="关闭提示" title="关闭"><X size={16} aria-hidden="true" /></button></div>;
}

function CreatorModal({ close, onAdd, existingUrls }: { close: () => void; onAdd: (items: CreatorDraft[]) => string | null; existingUrls: Set<string> }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const parsed = useMemo(() => parseCreatorLines(value), [value]);
  const hasParseError = parsed.invalidLines.length > 0 || parsed.limitExceeded;
  const importSummary = useMemo(() => {
    const knownUrls = new Set(existingUrls);
    let duplicateCount = parsed.duplicateLines.length;
    let newCount = 0;
    parsed.entries.forEach((entry) => {
      const urlKey = getFeedCreatorIdentityKey(entry.profileUrl, entry.platform);
      if (knownUrls.has(urlKey)) duplicateCount += 1;
      else {
        knownUrls.add(urlKey);
        newCount += 1;
      }
    });
    return { duplicateCount, newCount };
  }, [existingUrls, parsed.duplicateLines.length, parsed.entries]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setSubmitError("");
    if (!value.trim() || hasParseError || !importSummary.newCount) return;
    const error = onAdd(parsed.entries.filter((entry) => !existingUrls.has(getFeedCreatorIdentityKey(entry.profileUrl, entry.platform))));
    if (error) { setSubmitError(error); return; }
    close();
  };
  return <Modal title="添加关注博主" description="逐行粘贴主页链接，可在链接前后写昵称。" onClose={close} initialFocusRef={textareaRef} className="creator-modal"><form onSubmit={submit}><label className="field-label" htmlFor="creator-lines">主页名单</label><textarea ref={textareaRef} id="creator-lines" className="creator-textarea" value={value} onChange={(event) => { setValue(event.target.value); setSubmitted(false); setSubmitError(""); }} placeholder={'https://www.douyin.com/user/xxx\n哔站作者\thttps://space.bilibili.com/123'} rows={8} /><div className="import-summary"><span><strong>{parsed.entries.length}</strong> 条有效</span><span><strong>{importSummary.duplicateCount}</strong> 条重复</span><span className={parsed.invalidLines.length ? "has-error" : ""}><strong>{parsed.invalidLines.length}</strong> 行无效</span><span><strong>{importSummary.newCount}</strong> 位将新增</span></div>{parsed.limitExceeded ? <p className="field-error" role="alert">单次最多导入 {MAX_CREATOR_IMPORT_LINES.toLocaleString("zh-CN")} 行，请拆分名单后重试。</p> : null}{parsed.invalidLines.length ? <p className="field-error" role="alert">第 {parsed.invalidLines.join(", ")} 行无法识别。修正后才能确认导入。</p> : null}{submitted && !value.trim() ? <p className="field-error" role="alert">请先粘贴至少一条主页链接。</p> : null}{submitError ? <p className="field-error" role="alert">{submitError}</p> : null}<div className="modal-actions"><button className="secondary-button" type="button" onClick={close}>取消</button><button className="primary-button" type="submit" disabled={!importSummary.newCount || hasParseError}><UserCirclePlus size={18} aria-hidden="true" />确认添加</button></div></form></Modal>;
}

function VideoModal({ close, onSave, creators }: { close: () => void; onSave: (video: VideoItem) => boolean; creators: Creator[] }) {
  const metadataMessageId = useId();
  const metadataControllerRef = useRef<AbortController | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [creatorId, setCreatorId] = useState("");
  const [metadataState, setMetadataState] = useState<"idle" | "loading" | "error">("idle");
  const [metadataMessage, setMetadataMessage] = useState("");
  const [formError, setFormError] = useState("");
  useEffect(() => () => metadataControllerRef.current?.abort(), []);
  const platform = detectPlatform(url);
  const eligibleCreators = useMemo(
    () => creators.filter((creator) => creator.platform === platform),
    [creators, platform],
  );
  const selectedCreator = eligibleCreators.find((creator) => creator.id === creatorId)
    ?? eligibleCreators.find((creator) => creator.enabled)
    ?? eligibleCreators[0];
  const fetchMetadata = async () => {
    if (!platform) { setMetadataState("error"); setMetadataMessage("请先输入抖音或哔站公开链接。"); return; }
    metadataControllerRef.current?.abort();
    const controller = new AbortController();
    metadataControllerRef.current = controller;
    setMetadataState("loading");
    setMetadataMessage("正在读取公开信息");
    try {
      const response = await fetch("/api/metadata", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: normalizeUrl(url) }), signal: controller.signal });
      const data = await response.json() as { title?: string; coverUrl?: string; url?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "暂时无法读取公开信息");
      if (controller.signal.aborted) return;
      setUrl(data.url || url);
      setTitle(data.title || title);
      setCoverUrl(data.coverUrl || coverUrl);
      setMetadataState("idle");
      setMetadataMessage("已读取公开信息");
    } catch (error) {
      if (controller.signal.aborted) return;
      setMetadataState("error");
      setMetadataMessage(error instanceof Error ? error.message : "暂时无法读取公开信息");
    } finally {
      if (metadataControllerRef.current === controller) metadataControllerRef.current = null;
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!platform || !title.trim() || !selectedCreator) return;
    const videoUrl = normalizeUrl(url);
    const normalizedCoverUrl = coverUrl.trim() ? normalizeUrl(coverUrl) : "";
    if (videoUrl.length > MAX_FEED_URL_LENGTH) { setFormError(`视频链接最多 ${MAX_FEED_URL_LENGTH.toLocaleString("zh-CN")} 个字符。`); return; }
    if (title.trim().length > MAX_FEED_TITLE_LENGTH) { setFormError(`标题最多 ${MAX_FEED_TITLE_LENGTH.toLocaleString("zh-CN")} 个字符。`); return; }
    if (normalizedCoverUrl.length > MAX_FEED_URL_LENGTH) { setFormError(`封面链接最多 ${MAX_FEED_URL_LENGTH.toLocaleString("zh-CN")} 个字符。`); return; }
    setFormError("");
    const saved = onSave({ id: makeId("manual"), platform, videoUrl, creatorId: selectedCreator.id, title: title.trim(), ...(normalizedCoverUrl ? { coverUrl: normalizedCoverUrl } : {}), ...(publishedAt ? { publishedAt } : {}), source: "manual", createdAt: new Date().toISOString() });
    if (saved) close();
  };
  return <Modal title="保存一个视频" description="保留原站链接和少量公开元数据，视频仍在原平台播放。" onClose={close} className="video-modal"><form onSubmit={submit}><label className="field-label" htmlFor="video-url">视频链接</label><div className="field-with-action"><input id="video-url" type="url" value={url} maxLength={MAX_FEED_URL_LENGTH} onChange={(event) => { metadataControllerRef.current?.abort(); metadataControllerRef.current = null; setUrl(event.target.value); setMetadataState("idle"); setMetadataMessage(""); setFormError(""); }} placeholder="https://www.bilibili.com/video/BV..." aria-describedby={metadataMessage ? metadataMessageId : undefined} aria-invalid={metadataState === "error"} required /><button className="secondary-button" type="button" onClick={() => void fetchMetadata()} disabled={metadataState === "loading"}>{metadataState === "loading" ? <CircleNotch className="spin" size={17} aria-hidden="true" /> : <MagnifyingGlass size={17} aria-hidden="true" />}读取信息</button></div>{metadataMessage ? <p id={metadataMessageId} className={`field-hint ${metadataState === "error" ? "has-error" : ""}`} role={metadataState === "error" ? "alert" : "status"}>{metadataMessage}</p> : null}<label className="field-label" htmlFor="video-title">标题</label><input id="video-title" value={title} maxLength={MAX_FEED_TITLE_LENGTH} onChange={(event) => { setTitle(event.target.value); setFormError(""); }} placeholder="视频标题" required /><label className="field-label" htmlFor="video-creator">归属博主</label><select id="video-creator" value={selectedCreator?.id ?? ""} onChange={(event) => setCreatorId(event.target.value)} disabled={!eligibleCreators.length}><option value="">选择同平台关注博主</option>{eligibleCreators.map((creator) => <option key={creator.id} value={creator.id}>{creator.name} · {platformLabel(creator.platform)}</option>)}</select>{!creators.length ? <p className="field-error" role="alert">请先添加关注博主，再保存视频。</p> : platform && !eligibleCreators.length ? <p className="field-error" role="alert">关注列表中没有{platformLabel(platform)}博主，无法保存归属关系。</p> : null}<div className="field-grid"><div><label className="field-label" htmlFor="video-cover">封面链接（可选）</label><input id="video-cover" type="url" value={coverUrl} maxLength={MAX_FEED_URL_LENGTH} onChange={(event) => { setCoverUrl(event.target.value); setFormError(""); }} placeholder="https://..." /></div><div><label className="field-label" htmlFor="video-date">发布时间（可选）</label><input id="video-date" type="date" value={publishedAt} onChange={(event) => setPublishedAt(event.target.value)} /></div></div>{formError ? <p className="field-error" role="alert">{formError}</p> : null}<div className="modal-actions"><button className="secondary-button" type="button" onClick={close}>取消</button><button className="primary-button" type="submit" disabled={!platform || !title.trim() || !selectedCreator}><ListPlus size={18} aria-hidden="true" />保存视频</button></div></form></Modal>;
}

function ConfirmModal({ title, description, confirmLabel, onClose, onConfirm }: { title: string; description: string; confirmLabel: string; onClose: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return <Modal title={title} description={description} onClose={onClose} initialFocusRef={cancelRef}><div className="confirm-body"><p>原平台内容不会受到影响。</p><div className="modal-actions"><button ref={cancelRef} className="secondary-button" type="button" onClick={onClose}>取消</button><button className="danger-button" type="button" onClick={onConfirm}><Trash size={18} aria-hidden="true" />{confirmLabel}</button></div></div></Modal>;
}

function SettingsPanel({ close, onExport, onImport, onClear }: { close: () => void; onExport: () => void; onImport: () => void; onClear: () => void }) {
  const { preferences, setTheme, setVideoView } = useUiPreferences();
  const { syncStatus, syncFeed, storageStatus, dataAvailable } = useFeed();
  const storageUnavailable = storageStatus === "read-error" || storageStatus === "write-error" || storageStatus === "conflict";
  const dataReady = dataAvailable && !storageUnavailable;
  const themeOptions: Array<[UiTheme, string, ReactNode]> = [["system", "跟随系统", <Monitor key="system" size={17} aria-hidden="true" />], ["light", "浅色", <Sun key="light" size={17} aria-hidden="true" />], ["dark", "深色", <Moon key="dark" size={17} aria-hidden="true" />]];
  return <Modal title="数据与设置" description="本地浏览器数据、同步和显示偏好" onClose={close} className="settings-modal"><div className="settings-stack"><section className="settings-section"><div className="settings-section-heading"><div><h3>显示主题</h3><p>只影响当前浏览器。</p></div><SlidersHorizontal size={18} aria-hidden="true" /></div><div className="theme-options" role="group" aria-label="显示主题">{themeOptions.map(([value, label, icon]) => <button key={value} type="button" className={preferences.theme === value ? "is-active" : ""} aria-pressed={preferences.theme === value} onClick={() => setTheme(value)}>{icon}<span>{label}</span>{preferences.theme === value ? <Check size={15} aria-hidden="true" /> : null}</button>)}</div></section><section className="settings-section"><div className="settings-section-heading"><div><h3>视频显示</h3><p>网格适合浏览，列表适合快速扫描。</p></div><SquaresFour size={18} aria-hidden="true" /></div><ViewModeToggle value={preferences.videoView} onChange={setVideoView} /></section><section className="settings-section"><div className="settings-section-heading"><div><h3>同步中心</h3><p>{storageUnavailable ? "本地存储异常" : "只同步已启用的关注博主。"}</p></div><ArrowsClockwise size={18} aria-hidden="true" /></div><SyncProgress /><button className="secondary-button full-width" type="button" onClick={() => void syncFeed()} disabled={!dataReady || syncStatus === "loading"}><ArrowsClockwise size={18} aria-hidden="true" />{syncStatus === "loading" ? "同步进行中" : "同步全部关注"}</button></section><section className="settings-section"><div className="settings-section-heading"><div><h3>数据管理</h3><p>备份文件只保存在你的设备上。</p></div><CloudArrowUp size={18} aria-hidden="true" /></div><div className="settings-actions"><button className="secondary-button" type="button" onClick={onExport} disabled={!dataAvailable}><CloudArrowUp size={18} aria-hidden="true" />导出备份</button><button className="secondary-button" type="button" onClick={onImport} disabled={syncStatus === "loading" || (storageUnavailable && dataAvailable)}><CloudArrowDown size={18} aria-hidden="true" />导入备份</button><button className="danger-button subtle" type="button" onClick={onClear} disabled={!dataReady || syncStatus === "loading"}><Trash size={18} aria-hidden="true" />清空本地数据</button></div></section></div></Modal>;
}

function PageFrame({ active, children, openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear }: { active: HubView; children: ReactNode } & FrameProps) {
  const { creators, videos, dataAvailable, storageStatus, storageError, retryHydrate, retryPersist, syncStatus, syncFeed } = useFeed();
  const [recentNow, setRecentNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setRecentNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const storageUnavailable = storageStatus === "read-error" || storageStatus === "write-error" || storageStatus === "conflict";
  const storageReadError = storageStatus === "read-error";
  const dataReady = dataAvailable && !storageUnavailable;
  const enabledIds = useMemo(() => new Set(creators.filter((creator) => creator.enabled).map((creator) => creator.id)), [creators]);
  const recentCount = useMemo(() => videos.filter((video) => enabledIds.has(video.creatorId) && isRecentVideo(video, recentNow)).length, [enabledIds, recentNow, videos]);
  const storageNotice = storageError ? <div className="storage-banner" role="alert"><Warning size={18} aria-hidden="true" /><span>{storageError}</span><button className="text-button" type="button" onClick={storageReadError ? retryHydrate : retryPersist}>{storageReadError ? "重试读取" : storageStatus === "conflict" ? "导出后确认覆盖" : "重试保存"}</button></div> : null;
  const storageAction = storageReadError ? retryHydrate : retryPersist;
  return <div className="app-shell"><a className="skip-link" href="#main-content">跳到主要内容</a><aside className="sidebar" aria-label="侧边导航"><div className="brand-lockup"><span className="brand-symbol" aria-hidden="true"><FilmSlate size={23} weight="duotone" /></span><div><strong>只看关注</strong><span>个人视频收件箱</span></div></div><div className="sidebar-section-label">浏览</div><nav className="main-nav" aria-label="主导航"><Link className={active === "recent" ? "nav-item is-active" : "nav-item"} aria-current={active === "recent" ? "page" : undefined} href="/"><span><CalendarBlank size={18} aria-hidden="true" />最近更新</span><b>{formatCount(recentCount)}</b></Link><Link className={active === "following" ? "nav-item is-active" : "nav-item"} aria-current={active === "following" ? "page" : undefined} href="/following"><span><UserCirclePlus size={18} aria-hidden="true" />关注列表</span><b>{formatCount(creators.length)}</b></Link></nav><div className="sidebar-divider" /><button className="sidebar-action" type="button" onClick={openCreator} disabled={!dataReady}><UserCirclePlus size={18} aria-hidden="true" />添加博主</button><button className="sidebar-action" type="button" onClick={openVideo} disabled={!dataReady}><ListPlus size={18} aria-hidden="true" />保存一个视频</button><div className="sidebar-spacer" /><div className="local-note"><Info size={17} aria-hidden="true" /><p>数据只保存在此浏览器。</p></div><button className="sidebar-settings" type="button" onClick={() => setSettingsOpen(!settingsOpen)} aria-expanded={settingsOpen}><GearSix size={18} aria-hidden="true" />数据与设置</button></aside><div className="main-column"><header className="topbar"><div className="mobile-brand"><span className="brand-symbol" aria-hidden="true"><FilmSlate size={20} /></span><strong>只看关注</strong></div><div className={`topbar-status sync-status-${syncStatus}`} aria-live="polite"><span className="status-dot" aria-hidden="true" />{syncStatus === "loading" ? "同步中" : syncStatus === "success" ? "已同步" : syncStatus === "partial" ? "部分完成" : syncStatus === "error" ? "同步失败" : "本地保存"}</div><div className="topbar-actions"><button className="secondary-button sync-button" type="button" onClick={() => void syncFeed()} disabled={!dataReady || syncStatus === "loading"} aria-label="同步关注流" title="同步关注流"><ArrowsClockwise size={18} aria-hidden="true" /><span>同步关注流</span></button><button className="secondary-button add-topbar" type="button" onClick={openCreator} disabled={!dataReady}><Plus size={18} aria-hidden="true" /><span>添加博主</span></button><button className="primary-button save-topbar" type="button" onClick={openVideo} disabled={!dataReady}><ListPlus size={18} aria-hidden="true" /><span>保存视频</span></button><button className="mobile-settings-button icon-button" type="button" onClick={() => setSettingsOpen(!settingsOpen)} aria-label="打开数据与设置" aria-expanded={settingsOpen}><GearSix size={20} aria-hidden="true" /></button></div></header>{storageNotice}<SyncProgress compact /><main id="main-content" tabIndex={-1} className="content-wrap">{storageUnavailable ? storageReadError || !dataAvailable ? <StorageRecovery message={storageError || "请重试或导入备份。"} onRetry={retryHydrate} onImport={onImport} /> : <StorageWriteRecovery conflict={storageStatus === "conflict"} message={storageError || "请先导出备份，再重试保存。"} onRetry={storageAction} onExport={onExport} /> : children}</main></div><nav className="mobile-bottom-nav" aria-label="移动端主导航"><Link className={active === "recent" ? "is-active" : ""} aria-current={active === "recent" ? "page" : undefined} href="/"><CalendarBlank size={20} aria-hidden="true" /><span>最近更新</span></Link><Link className={active === "following" ? "is-active" : ""} aria-current={active === "following" ? "page" : undefined} href="/following"><UserCirclePlus size={20} aria-hidden="true" /><span>关注列表</span></Link></nav>{settingsOpen ? <SettingsPanel close={() => setSettingsOpen(false)} onExport={onExport} onImport={onImport} onClear={onClear} /> : null}<NoticeHost /></div>;
}

function RecentView({ openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear }: FrameProps) {
  const { creators, videos, isHydrated, setVideos, syncFeed } = useFeed();
  const { preferences, setVideoView } = useUiPreferences();
  const { showNotice, clearNotice } = useNotice();
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(VISIBLE_VIDEO_BATCH_SIZE);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const enabledIds = useMemo(() => new Set(creators.filter((creator) => creator.enabled).map((creator) => creator.id)), [creators]);
  const creatorById = useMemo(() => new Map(creators.map((creator) => [creator.id, creator])), [creators]);
  const recentBase = useMemo(() => videos.filter((video) => enabledIds.has(video.creatorId) && isRecentVideo(video, now)), [enabledIds, now, videos]);
  const counts = useMemo(() => ({ all: recentBase.length, douyin: recentBase.filter((video) => video.platform === "douyin").length, bilibili: recentBase.filter((video) => video.platform === "bilibili").length }), [recentBase]);
  const filtered = useMemo(() => { const needle = query.trim().toLocaleLowerCase(); return sortVideos(recentBase.filter((video) => platformMatches(platform, video.platform)).filter((video) => !needle || video.title.toLocaleLowerCase().includes(needle) || creatorById.get(video.creatorId)?.name.toLocaleLowerCase().includes(needle))); }, [creatorById, platform, query, recentBase]);
  const displayed = filtered.slice(0, visibleCount);
  const groups = displayed.reduce<Record<string, VideoItem[]>>((result, video) => { const key = parsePublishedAt(video.publishedAt)?.toDateString() ?? "unknown"; (result[key] ??= []).push(video); return result; }, {});
  const today = new Date(now).toDateString();
  const yesterday = new Date(now - DAY_MS).toDateString();
  const latestSync = Math.max(...creators.map((creator) => parsePublishedAt(creator.lastSyncAt)?.getTime() ?? 0), 0);
  const removeVideo = (video: VideoItem) => removeSavedVideo(video, setVideos, showNotice, clearNotice);
  if (!isHydrated) return <PageFrame active="recent" {...{ openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear }}><LoadingState /></PageFrame>;
  const emptyKind: EmptyKind = !creators.length ? "no-creators" : !recentBase.length ? "no-recent" : query.trim() ? "no-match" : platform !== "all" ? "no-platform" : "no-match";
  return <PageFrame active="recent" {...{ openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear }}><PageHeader eyebrow="FOLLOWING FEED" title="最近更新" subtitle="最近 7 天 · 按发布时间排序" stat={`${formatCount(filtered.length)} 条结果 · ${new Set(filtered.map((video) => video.creatorId)).size} 位博主 · 最近同步 ${formatDateTime(latestSync ? new Date(latestSync).toISOString() : undefined)}`} action={<button className="primary-button" type="button" onClick={openCreator}><Plus size={18} aria-hidden="true" />添加博主</button>} /><div className="content-toolbar"><PlatformTabs value={platform} onChange={(value) => { setPlatform(value); setVisibleCount(VISIBLE_VIDEO_BATCH_SIZE); }} counts={counts} /><SearchBox value={query} onChange={(value) => { setQuery(value); setVisibleCount(VISIBLE_VIDEO_BATCH_SIZE); }} placeholder="搜索博主或视频" /><ViewModeToggle value={preferences.videoView} onChange={setVideoView} /></div>{filtered.length === 0 ? <EmptyState kind={emptyKind} onAdd={openCreator} onSync={() => void syncFeed()} onClear={() => { setQuery(""); setPlatform("all"); setVisibleCount(VISIBLE_VIDEO_BATCH_SIZE); }} query={query} platform={platform} /> : <section className="feed-section"><div className="section-heading-row"><div><h2>本周更新</h2><span className="section-subtitle">平台总数 {formatCount(counts.all)} · 当前显示 {formatCount(filtered.length)}</span></div><button className="quiet-action" type="button" onClick={() => setSettingsOpen(true)}><GearSix size={17} aria-hidden="true" />管理数据</button></div>{Object.entries(groups).map(([key, items]) => <div className="date-group" key={key}><h3><CalendarBlank size={16} aria-hidden="true" />{key === "unknown" ? "日期未知" : key === today ? "今天" : key === yesterday ? "昨天" : formatDate(items[0].publishedAt)}</h3><div className={`video-grid ${preferences.videoView === "list" ? "is-list" : ""}`}>{items.map((video) => { const creator = creatorById.get(video.creatorId); return creator ? <VideoCard key={video.id} video={video} creator={creator} view={preferences.videoView} onDelete={video.source === "manual" || video.source === "public-metadata" ? removeVideo : undefined} /> : null; })}</div></div>)}{displayed.length < filtered.length ? <div className="load-more-row"><button className="secondary-button" type="button" onClick={() => setVisibleCount((count) => count + VISIBLE_VIDEO_BATCH_SIZE)}>加载更多<span>还剩 {formatCount(filtered.length - displayed.length)} 条</span></button></div> : null}</section>}</PageFrame>;
}

function FollowingView({ openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear }: FrameProps) {
  const { creators, videos, isHydrated, setCreators, setVideos, syncFeed, syncStatus } = useFeed();
  const { showNotice, clearNotice } = useNotice();
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [status, setStatus] = useState<CreatorStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [confirmCreator, setConfirmCreator] = useState<Creator | null>(null);
  const stats = useMemo(() => { const latestById = new Map<string, string | undefined>(); const latestMsById = new Map<string, number>(); const countById = new Map<string, number>(); videos.forEach((video) => { countById.set(video.creatorId, (countById.get(video.creatorId) ?? 0) + 1); const timestamp = videoTimestamp(video); if (timestamp > (latestMsById.get(video.creatorId) ?? Number.NEGATIVE_INFINITY)) { latestMsById.set(video.creatorId, timestamp); latestById.set(video.creatorId, video.publishedAt); } }); return { latestById, latestMsById, countById }; }, [videos]);
  const counts = useMemo(() => ({ all: creators.length, douyin: creators.filter((creator) => creator.platform === "douyin").length, bilibili: creators.filter((creator) => creator.platform === "bilibili").length }), [creators]);
  const statusCounts = useMemo(() => ({ all: creators.length, unsynced: creators.filter((creator) => !creator.lastSyncAt && !creator.syncError).length, failed: creators.filter((creator) => Boolean(creator.syncError)).length, paused: creators.filter((creator) => !creator.enabled).length }), [creators]);
  const filtered = useMemo(() => { const needle = query.trim().toLocaleLowerCase(); return creators.filter((creator) => platformMatches(platform, creator.platform)).filter((creator) => status === "all" || status === "unsynced" && !creator.lastSyncAt && !creator.syncError || status === "failed" && Boolean(creator.syncError) || status === "paused" && !creator.enabled).filter((creator) => !needle || creator.name.toLocaleLowerCase().includes(needle)).sort((a, b) => (stats.latestMsById.get(b.id) ?? Number.NEGATIVE_INFINITY) - (stats.latestMsById.get(a.id) ?? Number.NEGATIVE_INFINITY)); }, [creators, platform, query, stats.latestMsById, status]);
  const unfollow = useCallback((creator: Creator) => { const snapshot = { creator, videos: videos.filter((video) => video.creatorId === creator.id) }; setCreators((current) => current.filter((item) => item.id !== creator.id)); setVideos((current) => current.filter((video) => video.creatorId !== creator.id)); setConfirmCreator(null); let noticeId = ""; const undo = () => { setCreators((current) => current.some((item) => item.id === snapshot.creator.id) ? current : [...current, snapshot.creator]); setVideos((current) => { const known = new Set(current.map((video) => video.id)); return [...current, ...snapshot.videos.filter((video) => !known.has(video.id))]; }); clearNotice(noticeId); }; noticeId = showNotice({ kind: "success", text: `已取消关注 ${creator.name}`, action: { label: "撤销", onClick: undo } }, 10_000); }, [clearNotice, setCreators, setVideos, showNotice, videos]);
  if (!isHydrated) return <PageFrame active="following" {...{ openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear }}><LoadingState /></PageFrame>;
  const kind: EmptyKind = !creators.length ? "no-creators" : "no-following-match";
  return <PageFrame active="following" {...{ openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear }}><PageHeader eyebrow="YOUR SOURCES" title="关注列表" subtitle="管理你正在关注的所有博主" stat={`${formatCount(creators.length)} 位博主 · 抖音 ${formatCount(counts.douyin)} · 哔站 ${formatCount(counts.bilibili)}`} action={<button className="primary-button" type="button" onClick={openCreator}><Plus size={18} aria-hidden="true" />添加博主</button>} /><div className="content-toolbar content-toolbar-following"><PlatformTabs value={platform} onChange={setPlatform} counts={counts} /><StatusTabs value={status} onChange={setStatus} counts={statusCounts} /><SearchBox value={query} onChange={setQuery} placeholder="搜索博主" /></div><section className="creator-list-page"><div className="section-heading-row"><div><h2>全部关注</h2><span className="section-subtitle">暂停会保留缓存；取消关注会删除本地视频</span></div><button className="quiet-action" type="button" onClick={() => void syncFeed()} disabled={syncStatus === "loading"}><ArrowsClockwise size={17} aria-hidden="true" />{syncStatus === "loading" ? "同步中" : "全部同步"}</button></div>{filtered.length ? <div className="creator-list">{filtered.map((creator) => { const creatorVideoCount = stats.countById.get(creator.id) ?? 0; const latest = stats.latestById.get(creator.id); return <article className={`creator-list-card ${creator.enabled ? "" : "is-paused"}`} key={creator.id}><Link href={`/creator/${creator.id}`} className="creator-list-main" aria-label={`查看${creator.name}的个人页`}><Avatar creator={creator} size="large" /><span className="creator-list-copy"><strong>{creator.name}</strong><span><i className={`platform-dot ${platformClass(creator.platform)}`} />{platformLabel(creator.platform)} · {formatCount(creatorVideoCount)} 条视频 · 最近 {formatLongDate(latest)}</span><small>{creator.syncError ? `同步失败：${creator.syncError}` : creator.lastSyncAt ? `最后同步 ${formatDateTime(creator.lastSyncAt)}` : "尚未同步"}</small></span><ArrowUpRight size={18} aria-hidden="true" /></Link><div className="creator-list-status">{creator.enabled ? <span className="status-badge">已启用</span> : <span className="status-badge is-paused">已暂停</span>}{creator.syncError ? <span className="status-badge is-error">失败</span> : null}</div><div className="creator-list-actions"><a className="icon-button compact" href={creator.profileUrl} target="_blank" rel="noreferrer" aria-label={`打开${creator.name}的原平台主页`} title="打开原主页"><ArrowUpRight size={17} aria-hidden="true" /></a><button className="secondary-button compact-action" type="button" onClick={() => setCreators((current) => current.map((item) => item.id === creator.id ? { ...item, enabled: !item.enabled } : item))}>{creator.enabled ? "暂停" : "恢复"}</button><button className="secondary-button compact-action" type="button" onClick={() => void syncFeed([creator])} disabled={!creator.enabled || syncStatus === "loading"}><ArrowsClockwise size={16} aria-hidden="true" />重试</button><button className="icon-button compact danger-icon" type="button" onClick={() => setConfirmCreator(creator)} disabled={syncStatus === "loading"} aria-label={`取消关注${creator.name}`} title={`取消关注${creator.name}`}><Trash size={17} aria-hidden="true" /></button></div></article>; })}</div> : <EmptyState kind={kind} onAdd={openCreator} onSync={() => void syncFeed()} onClear={() => { setQuery(""); setStatus("all"); setPlatform("all"); }} query={query} platform={platform} />}</section>{confirmCreator ? <ConfirmModal title="取消关注" description={`将删除“${confirmCreator.name}”以及该博主的 ${formatCount(stats.countById.get(confirmCreator.id) ?? 0)} 条本地视频缓存。完成后可以在 10 秒内撤销。`} confirmLabel="确认取消关注" onClose={() => setConfirmCreator(null)} onConfirm={() => unfollow(confirmCreator)} /> : null}</PageFrame>;
}

function CreatorDetail({ creatorId, openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear }: FrameProps & { creatorId: string }) {
  const { creators, videos, isHydrated, setVideos, syncFeed, syncStatus } = useFeed();
  const { preferences, setVideoView } = useUiPreferences();
  const { showNotice, clearNotice } = useNotice();
  const creator = creators.find((item) => item.id === creatorId);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(VISIBLE_VIDEO_BATCH_SIZE);
  const allVideos = useMemo(() => sortVideos(videos.filter((video) => video.creatorId === creatorId)), [creatorId, videos]);
  const filtered = useMemo(() => { const needle = query.trim().toLocaleLowerCase(); return needle ? allVideos.filter((video) => video.title.toLocaleLowerCase().includes(needle)) : allVideos; }, [allVideos, query]);
  const removeVideo = (video: VideoItem) => removeSavedVideo(video, setVideos, showNotice, clearNotice);
  if (!isHydrated) return <PageFrame active="following" {...{ openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear }}><LoadingState /></PageFrame>;
  if (!creator) return <PageFrame active="following" {...{ openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear }}><div className="not-found-state"><span className="empty-icon"><UserCirclePlus size={30} aria-hidden="true" /></span><h1>博主不存在或已取消关注</h1><p>这条个人页只在当前浏览器的关注名单里有效。</p><Link className="secondary-button" href="/following"><ArrowLeft size={18} aria-hidden="true" />返回关注列表</Link></div></PageFrame>;
  const displayed = filtered.slice(0, visibleCount);
  return <PageFrame active="following" {...{ openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear }}><div className="creator-profile-header"><Link href="/following" className="back-link"><ArrowLeft size={18} aria-hidden="true" />返回关注列表</Link><div className="creator-profile-main"><Avatar creator={creator} size="large" /><div className="creator-profile-copy"><p className="eyebrow">{platformLabel(creator.platform)} · 关注博主</p><h1>{creator.name}</h1><p>{formatCount(allVideos.length)} 条视频 · 最近更新 {formatLongDate(creatorLatest(creator, videos))}</p></div><div className="creator-profile-actions"><a className="secondary-button" href={creator.profileUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={18} aria-hidden="true" />打开原主页</a><button className="primary-button" type="button" onClick={() => void syncFeed([creator])} disabled={!creator.enabled || syncStatus === "loading"}><ArrowsClockwise size={18} aria-hidden="true" />{syncStatus === "loading" ? "同步中" : creator.enabled ? "同步此博主" : "已暂停"}</button></div></div></div><section className="feed-section creator-detail-section"><div className="section-heading-row"><div><h2>全部视频</h2><span className="section-subtitle">按发布时间排序，未知日期排在末尾 · 共 {formatCount(filtered.length)} 条</span></div><div className="section-heading-tools"><SearchBox value={query} onChange={(value) => { setQuery(value); setVisibleCount(VISIBLE_VIDEO_BATCH_SIZE); }} placeholder="搜索该博主的视频" /><ViewModeToggle value={preferences.videoView} onChange={setVideoView} /></div></div>{displayed.length ? <div className={`video-grid ${preferences.videoView === "list" ? "is-list" : ""}`}>{displayed.map((video) => <VideoCard key={video.id} video={video} creator={creator} view={preferences.videoView} onDelete={video.source === "manual" || video.source === "public-metadata" ? removeVideo : undefined} />)}</div> : <EmptyState kind={query ? "no-match" : "no-videos"} onAdd={openCreator} onSync={() => void syncFeed([creator])} onClear={() => { setQuery(""); setVisibleCount(VISIBLE_VIDEO_BATCH_SIZE); }} query={query} />}{displayed.length < filtered.length ? <div className="load-more-row"><button className="secondary-button" type="button" onClick={() => setVisibleCount((count) => count + VISIBLE_VIDEO_BATCH_SIZE)}>加载更多<span>还剩 {formatCount(filtered.length - displayed.length)} 条</span></button></div> : null}</section></PageFrame>;
}

export function VideoHub({ view = "recent", creatorId }: { view?: HubView; creatorId?: string }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modal, setModal] = useState<"creator" | "video" | "clear" | null>(null);
  const [pendingBackup, setPendingBackup] = useState<FeedState | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { creators, videos, dataAvailable, replaceState, setVideos, setCreators, storageStatus, syncStatus } = useFeed();
  const { showNotice } = useNotice();
  const storageUnavailable = storageStatus === "read-error" || storageStatus === "write-error" || storageStatus === "conflict";
  const dataReady = dataAvailable && !storageUnavailable;
  const openCreator = useCallback(() => { if (!dataReady) return; setSettingsOpen(false); setModal("creator"); }, [dataReady]);
  const openVideo = useCallback(() => { if (!dataReady) return; setSettingsOpen(false); setModal("video"); }, [dataReady]);
  const onExport = useCallback(() => { const payload = { version: 2, exportedAt: new Date().toISOString(), creators, videos }; const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }); if (blob.size > MAX_BACKUP_FILE_BYTES) { showNotice({ kind: "error", text: "当前数据超过 64 MB 备份上限，请先减少本地视频数量" }); return; } const link = document.createElement("a"); const objectUrl = URL.createObjectURL(blob); link.href = objectUrl; link.download = `just-follow-feed-${new Date().toISOString().slice(0, 10)}.json`; link.click(); window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); showNotice({ kind: "success", text: "备份已导出" }); }, [creators, showNotice, videos]);
  const onImport = useCallback(() => fileRef.current?.click(), []);
  const onFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; if (syncStatus === "loading") { showNotice({ kind: "info", text: "同步进行中，请完成或取消同步后再导入备份" }); return; } if (file.size > MAX_BACKUP_FILE_BYTES) { showNotice({ kind: "error", text: "备份文件超过 64 MB，已停止读取" }); return; } try { const parsed = JSON.parse(await file.text()); const state = migrateFeedState(parsed); if (!state) throw new Error("备份格式不受支持、数据超限或存在损坏记录"); setSettingsOpen(false); setPendingBackup(state); } catch (error) { showNotice({ kind: "error", text: error instanceof Error ? error.message : "备份文件无法读取" }); } }, [showNotice, syncStatus]);
  const confirmImport = useCallback(() => { if (!pendingBackup || syncStatus === "loading") return; replaceState(pendingBackup); setPendingBackup(null); setSettingsOpen(false); showNotice({ kind: "success", text: `已导入 ${pendingBackup.creators.length} 位博主和 ${pendingBackup.videos.length} 条视频` }); }, [pendingBackup, replaceState, showNotice, syncStatus]);
  const clearAll = useCallback(() => { if (!dataReady || syncStatus === "loading") return; setModal("clear"); }, [dataReady, syncStatus]);
  const confirmClear = useCallback(() => { if (!dataReady) return; replaceState({ version: 2, creators: [], videos: [] }); setModal(null); setSettingsOpen(false); showNotice({ kind: "success", text: "本地数据已清空" }); }, [dataReady, replaceState, showNotice]);
  const existingUrls = useMemo(() => new Set(creators.map((creator) => getFeedCreatorIdentityKey(creator.profileUrl, creator.platform))), [creators]);
  const addCreators = useCallback((items: CreatorDraft[]) => {
    if (!dataReady) return "本地数据尚未就绪，请先完成恢复";
    const validItems = items.filter((item) => isPlatformProfileUrl(item.profileUrl, item.platform));
    if (validItems.length !== items.length) return "名单中包含非博主主页链接，请检查后重试";
    const knownUrls = new Set(existingUrls);
    const additions = validItems.flatMap((item) => {
      const urlKey = getFeedCreatorIdentityKey(item.profileUrl, item.platform);
      if (knownUrls.has(urlKey)) return [];
      knownUrls.add(urlKey);
      return [{ ...item, id: makeId("creator"), enabled: true }];
    });
    if (!additions.length) return "这些主页都已经在关注名单里了";
    if (creators.length + additions.length > MAX_FEED_CREATORS) return `关注博主最多保存 ${MAX_FEED_CREATORS.toLocaleString("zh-CN")} 位，请先清理旧名单`;
    setCreators((current) => [...current, ...additions]);
    showNotice({ kind: "success", text: `已添加 ${additions.length} 位博主` });
    return null;
  }, [creators.length, dataReady, existingUrls, setCreators, showNotice]);
  const saveVideo = useCallback((video: VideoItem) => {
    if (!dataReady) {
      showNotice({ kind: "error", text: "本地数据尚未就绪，请先完成恢复" });
      return false;
    }
    const creator = creators.find((item) => item.id === video.creatorId);
    if (!creator || creator.platform !== video.platform || !isPlatformVideoUrl(video.videoUrl, video.platform)) {
      showNotice({ kind: "error", text: "视频链接与归属博主的平台不一致，未保存" });
      return false;
    }
    const videoUrlKey = getFeedVideoIdentityKey(video.videoUrl, video.platform);
    if (videos.some((entry) => getFeedVideoIdentityKey(entry.videoUrl, entry.platform) === videoUrlKey)) {
      showNotice({ kind: "info", text: "这个视频已经在本地保存" });
      return false;
    }
    setVideos((current) => [...current, video]);
    showNotice({ kind: "success", text: "视频已保存" });
    return true;
  }, [creators, dataReady, setVideos, showNotice, videos]);
  const frameProps = { openCreator, openVideo, settingsOpen, setSettingsOpen, onExport, onImport, onClear: clearAll };
  return <>{creatorId ? <CreatorDetail creatorId={creatorId} {...frameProps} /> : view === "following" ? <FollowingView {...frameProps} /> : <RecentView {...frameProps} />}{modal === "creator" ? <CreatorModal close={() => setModal(null)} onAdd={addCreators} existingUrls={existingUrls} /> : null}{modal === "video" ? <VideoModal close={() => setModal(null)} onSave={saveVideo} creators={creators} /> : null}{modal === "clear" ? <ConfirmModal title="清空本地数据" description="将删除所有关注博主、视频缓存和同步状态，此操作无法撤销。" confirmLabel="确认清空" onClose={() => setModal(null)} onConfirm={confirmClear} /> : null}{pendingBackup ? <ConfirmModal title="导入备份" description={`将用备份中的 ${pendingBackup.creators.length} 位博主和 ${pendingBackup.videos.length} 条视频替换当前数据。`} confirmLabel="确认导入" onClose={() => setPendingBackup(null)} onConfirm={confirmImport} /> : null}<input ref={fileRef} className="visually-hidden" type="file" tabIndex={-1} accept="application/json,.json" onChange={onFileChange} aria-label="选择备份文件" /></>;
}

export default VideoHub;
