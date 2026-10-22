"use client";

import {
  ArrowsClockwise,
  Check,
  CheckCircle,
  CloudArrowDown,
  Copy,
  DownloadSimple,
  FileArrowUp,
  StopCircle,
  Warning,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getFeedCreatorIdentityKey } from "@/lib/feed-storage";
import {
  FOLLOWING_FILE_BYTES,
  makeBilibiliBridgeScript,
  followingKey,
  followingText,
  makeFollowingFile,
  parseFollowingFile,
  readFollowingStream,
  type FollowingCreator,
  type FollowingResult,
} from "@/lib/following-list";
import type { Creator, Platform } from "@/lib/feed-types";
import type { CreatorDraft } from "@/components/video-hub/helpers";

type Props = {
  close: () => void;
  existingCreators: Creator[];
  onAdd: (items: CreatorDraft[]) => string | null;
};

const EMPTY_SELECTION = new Set<string>();
type PlatformProgress = { received: number; total?: number; invalidCount: number };

function download(name: string, content: string, type: string) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([content], { type }));
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FollowingCollector({ close, existingCreators, onAdd }: Props) {
  const [platforms, setPlatforms] = useState<Record<Platform, boolean>>({ douyin: true, bilibili: true });
  const [creators, setCreators] = useState<FollowingCreator[]>([]);
  const [results, setResults] = useState<FollowingResult[]>([]);
  const [accounts, setAccounts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(EMPTY_SELECTION);
  const [includePartial, setIncludePartial] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [bridgeScript, setBridgeScript] = useState("");
  const [bridgeState, setBridgeState] = useState<"idle" | "waiting">("idle");
  const [progress, setProgress] = useState<Record<Platform, PlatformProgress>>({ douyin: { received: 0, invalidCount: 0 }, bilibili: { received: 0, invalidCount: 0 } });
  const controllerRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const creatorsRef = useRef(creators);
  const progressRef = useRef(progress);
  const bridgeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  creatorsRef.current = creators;
  progressRef.current = progress;

  useEffect(() => () => {
    // Closing the dialog must stop an in-flight extraction (and the temporary
    // browser it drives) instead of letting it keep running in the background.
    controllerRef.current?.abort();
    if (bridgeTimerRef.current) clearInterval(bridgeTimerRef.current);
  }, []);

  const existingKeys = useMemo(() => new Set(existingCreators.map((creator) => getFeedCreatorIdentityKey(creator.profileUrl, creator.platform))), [existingCreators]);
  const newCreators = useMemo(() => creators.filter((creator) => !existingKeys.has(getFeedCreatorIdentityKey(creator.profileUrl, creator.platform))), [creators, existingKeys]);
  const selectable = useMemo(() => newCreators.filter((creator) => {
    const result = results.find((item) => item.platform === creator.platform);
    return result?.status === "complete" || includePartial;
  }), [includePartial, newCreators, results]);
  const selectedCount = selectable.filter((creator) => selected.has(followingKey(creator))).length;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;
  const hasPartial = results.some((result) => result.status !== "complete");
  const duplicateCount = creators.length - newCreators.length;
  const invalidCount = results.reduce((total, result) => total + result.invalidCount, 0);
  const exportCreators = useMemo(() => includePartial
    ? creators
    : creators.filter((creator) => results.find((result) => result.platform === creator.platform)?.status === "complete"), [creators, includePartial, results]);

  const resetResults = () => {
    creatorsRef.current = [];
    setCreators([]); setResults([]); setAccounts({}); setSelected(new Set()); setMessage("");
    setIncludePartial(false);
    const initialProgress = { douyin: { received: 0, invalidCount: 0 }, bilibili: { received: 0, invalidCount: 0 } };
    progressRef.current = initialProgress;
    setProgress(initialProgress);
  };

  const collect = async (requestedPlatforms?: Platform[]) => {
    const chosen = requestedPlatforms ?? (Object.keys(platforms) as Platform[]).filter((platform) => platforms[platform]);
    if (!chosen.length || status === "loading") return;
    if (requestedPlatforms) {
      setIncludePartial(false);
      const retained = creatorsRef.current.filter((creator) => !chosen.includes(creator.platform));
      creatorsRef.current = retained;
      setCreators(retained);
      setResults((current) => current.filter((result) => !chosen.includes(result.platform)));
      setAccounts((current) => Object.fromEntries(Object.entries(current).filter(([platform]) => !chosen.includes(platform as Platform))));
      setSelected((current) => {
        const next = new Set(current);
        creatorsRef.current.filter((creator) => chosen.includes(creator.platform)).forEach((creator) => next.delete(followingKey(creator)));
        return next;
      });
      const nextProgress = Object.fromEntries(Object.entries(progressRef.current).map(([platform, value]) => [platform, chosen.includes(platform as Platform) ? { received: 0, invalidCount: 0 } : value])) as Record<Platform, PlatformProgress>;
      progressRef.current = nextProgress;
      setProgress(nextProgress);
    } else {
      resetResults();
    }
    setStatus("loading");
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await fetch("/api/following/collect", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ platforms: chosen }), signal: controller.signal,
      });
      await readFollowingStream(response, (event) => {
        if (event.type === "account") setAccounts((current) => ({ ...current, [event.platform]: event.account.name }));
        if (event.type === "page") {
          const nextProgress = { ...progressRef.current, [event.platform]: { received: event.received, total: event.total, invalidCount: event.invalidCount } };
          progressRef.current = nextProgress;
          setProgress(nextProgress);
          const known = new Set(creatorsRef.current.map(followingKey));
          const additions = event.creators.filter((creator) => {
            const key = followingKey(creator);
            if (known.has(key)) return false;
            known.add(key);
            return true;
          });
          creatorsRef.current = [...creatorsRef.current, ...additions];
          setCreators(creatorsRef.current);
        }
        if (event.type === "result") {
          setResults((current) => [...current.filter((item) => item.platform !== event.result.platform), event.result]);
          setSelected((current) => {
            const next = new Set(current);
            creatorsRef.current.filter((creator) => creator.platform === event.result.platform).forEach((creator) => {
              if (event.result.status === "complete" && !existingKeys.has(getFeedCreatorIdentityKey(creator.profileUrl, creator.platform))) next.add(followingKey(creator));
              if (event.result.status !== "complete") next.delete(followingKey(creator));
            });
            return next;
          });
        }
      }, controller.signal);
      setStatus("done");
      setMessage("提取完成，请检查并选择要追加的博主");
    } catch (error) {
      setResults((current) => {
        const known = new Set(current.map((result) => result.platform));
        return [...current, ...chosen.filter((platform) => !known.has(platform)).map((platform) => ({
          platform,
          status: controller.signal.aborted ? "cancelled" as const : progressRef.current[platform].received ? "partial" as const : "error" as const,
          received: progressRef.current[platform].received,
          ...(progressRef.current[platform].total === undefined ? {} : { total: progressRef.current[platform].total }),
          invalidCount: progressRef.current[platform].invalidCount,
          message: controller.signal.aborted ? "提取已取消" : error instanceof Error ? error.message : "提取中断",
        }))];
      });
      setStatus(controller.signal.aborted ? "idle" : "error");
      setMessage(controller.signal.aborted ? "已取消提取，已获取的结果仍可预览" : (error instanceof Error ? error.message : "关注名单提取失败"));
    } finally { controllerRef.current = null; }
  };

  const connectBilibiliPage = async () => {
    if (status === "loading" || bridgeState === "waiting") return;
    try {
      const response = await fetch("/api/following/bridge/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const session = await response.json() as { token?: string; expiresAt?: number; error?: string };
      if (!response.ok || !session.token) throw new Error(session.error || "无法创建浏览器连接");
      const script = makeBilibiliBridgeScript(window.location.origin, session.token);
      setIncludePartial(false);
      setBridgeScript(script);
      setBridgeState("waiting");
      setMessage("连接脚本已生成。切到哔站页面的控制台粘贴并回车，完成后切回本站。");
      try { await navigator.clipboard?.writeText(script); } catch { /* The visible script remains available for manual copy. */ }
      if (bridgeTimerRef.current) clearInterval(bridgeTimerRef.current);
      bridgeTimerRef.current = setInterval(async () => {
        try {
          if (typeof session.expiresAt === "number" && Date.now() >= session.expiresAt) {
            throw new Error("浏览器连接已过期，请重新连接当前哔站页面");
          }
          const resultResponse = await fetch("/api/following/bridge/result", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: session.token }),
          });
          if (resultResponse.status === 202) return;
          const payload = await resultResponse.json() as {
            account?: { id: string; name: string };
            creators?: FollowingCreator[];
            result?: FollowingResult;
            error?: string;
          };
          if (!resultResponse.ok || !payload.result || !payload.creators || !payload.account) {
            throw new Error(payload.error || "浏览器连接返回的数据无效");
          }
          if (bridgeTimerRef.current) clearInterval(bridgeTimerRef.current);
          bridgeTimerRef.current = null;
          setBridgeState("idle");
          setCreators((current) => [...current.filter((creator) => creator.platform !== "bilibili"), ...payload.creators!]);
          setResults((current) => [...current.filter((result) => result.platform !== "bilibili"), payload.result!]);
          setAccounts((current) => ({ ...current, bilibili: payload.account!.name }));
          setProgress((current) => ({ ...current, bilibili: { received: payload.result!.received, total: payload.result!.total, invalidCount: payload.result!.invalidCount } }));
          setSelected((current) => {
            const next = new Set([...current].filter((key) => !key.startsWith("bilibili:")));
            payload.creators!.filter((creator) => payload.result!.status === "complete" && !existingKeys.has(getFeedCreatorIdentityKey(creator.profileUrl, creator.platform))).forEach((creator) => next.add(followingKey(creator)));
            return next;
          });
          setStatus("done");
          setMessage(payload.result.status === "complete" ? "已从当前哔站页面取得关注名单，请检查并选择要追加的博主" : "已取得哔站部分名单，请确认后再选择是否包含未完整结果");
        } catch (error) {
          if (bridgeTimerRef.current) clearInterval(bridgeTimerRef.current);
          bridgeTimerRef.current = null;
          setBridgeState("idle");
          setStatus("error");
          setMessage(error instanceof Error ? error.message : "浏览器连接失败");
        }
      }, 1_000);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "无法创建浏览器连接");
    }
  };

  const importFile = async (file: File) => {
    if (file.size > FOLLOWING_FILE_BYTES) { setMessage("名单文件超过 16 MB，已停止读取"); return; }
    try {
      const parsed = parseFollowingFile(JSON.parse(await file.text()));
      setCreators(parsed.creators); setResults(parsed.platformResults);
      creatorsRef.current = parsed.creators;
      setAccounts({});
      setIncludePartial(false);
      setSelected(new Set(parsed.creators.filter((creator) => parsed.platformResults.some((result) => result.platform === creator.platform && result.status === "complete") && !existingKeys.has(getFeedCreatorIdentityKey(creator.profileUrl, creator.platform))).map(followingKey)));
      setProgress(Object.fromEntries(parsed.platformResults.map((result) => [result.platform, { received: result.received, total: result.total, invalidCount: result.invalidCount }])) as Record<Platform, PlatformProgress>);
      setStatus("done"); setMessage("已载入名单文件，请检查并选择要追加的博主");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "名单文件无法读取"); }
  };

  const addSelected = () => {
    const items = creators.filter((creator) => selected.has(followingKey(creator))
      && (includePartial || results.find((result) => result.platform === creator.platform)?.status === "complete"))
      .map((creator) => ({ platform: creator.platform, profileUrl: creator.profileUrl, name: creator.name, nameSource: "platform" as const, ...(creator.avatarUrl ? { avatarUrl: creator.avatarUrl } : {}) }));
    if (!items.length) { setMessage("请至少选择一位新博主"); return; }
    const error = onAdd(items);
    if (error) setMessage(error);
    else { setMessage(`已追加 ${items.length} 位博主`); setSelected(EMPTY_SELECTION); }
  };

  const exportFile = (format: "json" | "txt") => {
    if (!creators.length) { setMessage("暂无可导出的名单"); return; }
    if (hasPartial && !includePartial) { setMessage("当前包含未完整平台结果，请勾选“包含未完整结果”后导出"); return; }
    if (format === "txt") download(`following-list${hasPartial && includePartial ? "-partial" : ""}.txt`, followingText(exportCreators), "text/plain;charset=utf-8");
    else download(`following-list${hasPartial && includePartial ? "-partial" : ""}.json`, JSON.stringify(makeFollowingFile(exportCreators, results), null, 2), "application/json");
  };

  const copyList = async () => {
    if (!creators.length) { setMessage("暂无可复制的名单"); return; }
    if (hasPartial && !includePartial) { setMessage("当前包含未完整平台结果，请勾选“包含未完整结果”后复制"); return; }
    const text = followingText(exportCreators);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = text; textarea.setAttribute("readonly", ""); textarea.style.position = "fixed"; textarea.style.opacity = "0";
        document.body.appendChild(textarea); textarea.select();
        if (!document.execCommand("copy")) throw new Error("copy failed");
        textarea.remove();
      }
      setMessage(`已复制 ${exportCreators.length} 位博主`);
    } catch { setMessage("复制失败，请改用导出 TXT"); }
  };

  return <div className="following-collector">
    <div className="collector-platforms" role="group" aria-label="选择提取平台">
      {(Object.keys(platforms) as Platform[]).map((platform) => <label key={platform} className="collector-platform-option"><input type="checkbox" checked={platforms[platform]} disabled={status === "loading"} onChange={(event) => setPlatforms((current) => ({ ...current, [platform]: event.target.checked }))} /><span>{platform === "douyin" ? "抖音" : "哔站"}</span></label>)}
    </div>
    {Object.keys(accounts).length ? <p className="collector-account">{Object.entries(accounts).map(([platform, account]) => `${platform === "douyin" ? "抖音" : "哔站"}：${account}`).join(" · ")}</p> : null}
    <div className="collector-actions"><button className="primary-button" type="button" onClick={() => void collect()} disabled={status === "loading" || bridgeState === "waiting" || !Object.values(platforms).some(Boolean)}>{status === "loading" ? <CircleNotchIcon /> : <CloudArrowDown size={18} aria-hidden="true" />}{status === "loading" ? "提取中" : "开始提取"}</button>{status === "loading" ? <button className="secondary-button" type="button" onClick={() => controllerRef.current?.abort()}><StopCircle size={18} aria-hidden="true" />取消</button> : null}<button className="secondary-button" type="button" onClick={() => void connectBilibiliPage()} disabled={status === "loading" || bridgeState === "waiting"}><Copy size={18} aria-hidden="true" />连接当前哔站页面</button><button className="secondary-button" type="button" onClick={() => fileRef.current?.click()} disabled={status === "loading" || bridgeState === "waiting"}><FileArrowUp size={18} aria-hidden="true" />导入名单 JSON</button><input ref={fileRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} /></div>
    {bridgeState === "waiting" ? <div className="collector-bridge" role="status"><strong>浏览器连接已等待</strong><p>1. 切换到已登录的哔站页面。2. 在控制台粘贴脚本并回车。3. 脚本完成后切回本站，结果会自动出现。</p><textarea readOnly value={bridgeScript} aria-label="哔站连接脚本" rows={4} /><div className="collector-actions"><button className="text-button" type="button" onClick={() => void navigator.clipboard?.writeText(bridgeScript)}><Copy size={16} aria-hidden="true" />再次复制连接脚本</button><button className="text-button" type="button" onClick={() => { if (bridgeTimerRef.current) clearInterval(bridgeTimerRef.current); bridgeTimerRef.current = null; setBridgeState("idle"); setBridgeScript(""); setMessage("已取消浏览器连接"); }}>取消连接</button></div></div> : null}
    {message ? <p className={`collector-message collector-message-${status === "error" ? "error" : "info"}`} role={status === "error" ? "alert" : "status"}><Warning size={16} aria-hidden="true" />{message}</p> : null}
    {status === "loading" ? <div className="collector-progress" role="status" aria-live="polite">{(Object.keys(platforms) as Platform[]).filter((platform) => platforms[platform]).map((platform) => <span key={platform}>{platform === "douyin" ? "抖音" : "哔站"} {progress[platform].received}{progress[platform].total === undefined ? "" : ` / ${progress[platform].total}`}</span>)}</div> : null}
    {results.length ? <div className="collector-summary">{results.map((result) => <span key={result.platform} className={`collector-result collector-result-${result.status}`}>{result.status === "complete" ? <CheckCircle size={16} aria-hidden="true" /> : <Warning size={16} aria-hidden="true" />}{result.platform === "douyin" ? "抖音" : "哔站"}：{result.status === "complete" ? `已获取 ${result.received} 位${result.invalidCount ? `，异常 ${result.invalidCount} 条` : ""}` : `${result.message || "结果不完整"}（已获取 ${result.received} 位，异常 ${result.invalidCount} 条）`}{result.status !== "complete" ? <button className="text-button" type="button" onClick={() => void collect([result.platform])} disabled={status === "loading"}><ArrowsClockwise size={16} aria-hidden="true" />重新提取</button> : null}</span>)}</div> : null}
    {hasPartial ? <label className="collector-partial-toggle"><input type="checkbox" checked={includePartial} onChange={(event) => setIncludePartial(event.target.checked)} />包含未完整结果</label> : null}
    {creators.length ? <div className="collector-preview"><div className="collector-preview-header"><strong>预览名单（新增 {newCreators.length} 位，重复 {duplicateCount} 位，异常 {invalidCount} 条，已选 {selectedCount} 位）</strong><button className="text-button" type="button" onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map(followingKey)))}>{allSelected ? "取消全选" : "全选可提交"}</button></div><div className="collector-rows">{creators.map((creator) => { const isExisting = existingKeys.has(getFeedCreatorIdentityKey(creator.profileUrl, creator.platform)); const canSelect = !isExisting && (includePartial || results.find((result) => result.platform === creator.platform)?.status === "complete"); return <label className={`collector-row ${isExisting ? "is-existing" : ""}`} key={followingKey(creator)}><input type="checkbox" checked={selected.has(followingKey(creator))} disabled={!canSelect} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(followingKey(creator)); else next.delete(followingKey(creator)); return next; })} /><span><strong>{creator.name}</strong><small>{creator.platform === "douyin" ? "抖音" : "哔站"} · {creator.profileUrl}{isExisting ? " · 已在本站" : ""}</small></span></label>; })}</div></div> : null}
    <div className="collector-footer"><button className="secondary-button" type="button" onClick={() => void copyList()} disabled={!creators.length}><Copy size={18} aria-hidden="true" />复制名单</button><button className="secondary-button" type="button" onClick={() => exportFile("json")} disabled={!creators.length}><DownloadSimple size={18} aria-hidden="true" />导出 JSON</button><button className="secondary-button" type="button" onClick={() => exportFile("txt")} disabled={!creators.length}><DownloadSimple size={18} aria-hidden="true" />导出 TXT</button><button className="primary-button" type="button" onClick={addSelected} disabled={!selectedCount || status === "loading"}><Check size={18} aria-hidden="true" />追加到本站</button></div>
  </div>;
}

function CircleNotchIcon() { return <ArrowsClockwise className="spin" size={18} aria-hidden="true" />; }
