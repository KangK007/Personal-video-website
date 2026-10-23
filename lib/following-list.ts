import type { Platform } from "@/lib/feed-types";

export const FOLLOWING_LIMIT = 10_000;
export const FOLLOWING_FILE_BYTES = 32 * 1024 * 1024;

export type FollowingCreator = {
  platform: Platform;
  platformUserId: string;
  name: string;
  profileUrl: string;
  avatarUrl?: string;
};

export type FollowingResult = {
  platform: Platform;
  status: "complete" | "partial" | "error" | "cancelled";
  received: number;
  total?: number;
  invalidCount: number;
  code?: string;
  message?: string;
};

export type FollowingEvent =
  | { type: "account"; platform: Platform; account: { id: string; name: string } }
  | { type: "page"; platform: Platform; creators: FollowingCreator[]; received: number; total?: number; invalidCount: number }
  | { type: "result"; result: FollowingResult }
  | { type: "error"; error: string }
  | { type: "done" };

export type FollowingFile = {
  kind: "following-list";
  version: 1;
  exportedAt: string;
  creators: FollowingCreator[];
  platformResults: FollowingResult[];
};

export function isFollowingPlatform(value: unknown): value is Platform {
  return value === "douyin" || value === "bilibili";
}

export function followingKey(creator: Pick<FollowingCreator, "platform" | "platformUserId">) {
  return `${creator.platform}:${creator.platformUserId}`;
}

export function followingProfileUrl(platform: Platform, id: string) {
  return platform === "douyin" ? `https://www.douyin.com/user/${id}` : `https://space.bilibili.com/${id}`;
}

export function validFollowingId(platform: Platform, id: unknown): id is string {
  return typeof id === "string" && (platform === "bilibili" ? /^[1-9]\d{0,24}$/ : /^[\w-]{1,256}$/).test(id);
}

export function cleanFollowingName(value: unknown, platform: Platform) {
  return (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80) : "")
    || (platform === "douyin" ? "抖音博主" : "哔站博主");
}

export function followingAvatar(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

export function followingText(creators: FollowingCreator[]) {
  return creators.map((creator) => `${creator.profileUrl}\t${cleanFollowingName(creator.name, creator.platform)}`).join("\n");
}

export function makeFollowingFile(creators: FollowingCreator[], platformResults: FollowingResult[]): FollowingFile {
  return {
    kind: "following-list", version: 1, exportedAt: new Date().toISOString(),
    creators, platformResults,
  };
}

/** Create a one-time console handoff for a live Bilibili page. It never reads or prints cookies. */
export function makeBilibiliBridgeScript(appOrigin: string, token: string) {
  const bridgeUrl = new URL("/following/bridge", appOrigin).toString();
  return [
    "(async()=>{",
    `const bridgeToken=${JSON.stringify(token)};`,
    `const bridgeUrl=${JSON.stringify(bridgeUrl)};`,
    `const appOrigin=${JSON.stringify(new URL(appOrigin).origin)};`,
    "if(!/(^|\\.)bilibili\\.com$/.test(location.hostname)){alert('请在已登录的哔哩哔哩网页运行连接脚本');return;}",
    "const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));",
    "const fetchJson=async url=>{for(let attempt=0;attempt<3;attempt++){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);try{const response=await fetch(url,{credentials:'include',signal:controller.signal});if(response.status===429)throw new Error('哔站关注接口已限流');if(response.status>=500)throw new Error('哔站接口暂时不可用');if(!response.ok)throw new Error('哔站接口返回 '+response.status);return await response.json();}catch(error){if(attempt===2||!/AbortError|TypeError|暂时不可用/.test(String(error)))throw error;await sleep(attempt===0?2000:5000);}finally{clearTimeout(timer);}}};",
    "let bridgeWindow=null;",
    "try{",
    "bridgeWindow=window.open(bridgeUrl+'#token='+encodeURIComponent(bridgeToken),'_blank');",
    "if(!bridgeWindow)throw new Error('浏览器阻止打开本站连接页，请允许弹出窗口后重试');",
    "const nav=await fetchJson('https://api.bilibili.com/x/web-interface/nav');",
    "if(nav.code!==0||nav.data?.isLogin!==true)throw new Error('哔站当前页面未登录');",
    "const uid=String(nav.data.mid||'');",
    "if(!/^[1-9]\\d{0,24}$/.test(uid))throw new Error('哔站登录账号 UID 无效');",
    "const ids=new Set(),creators=[];let total=null,invalidCount=0,message='';",
    "try{",
    "for(let pn=1;pn<=1000;pn++){",
    "const params=new URLSearchParams({vmid:uid,pn:String(pn),ps:'50',order:'desc',order_type:'attention',web_location:'333.1387'});",
    "const payload=await fetchJson('https://api.bilibili.com/x/relation/followings?'+params);",
    "if(payload.code!==0)throw new Error(payload.message||('哔站接口返回 '+payload.code));",
    "const data=payload.data||{},list=Array.isArray(data.list)?data.list:[],currentTotal=Number(data.total);",
    "if(!Number.isSafeInteger(currentTotal)||currentTotal<0||currentTotal>10000)throw new Error('哔站关注总数无效');",
    "if(total!==null&&total!==currentTotal)throw new Error('哔站关注总数发生变化');total=currentTotal;",
    "let added=0;for(const item of list){const id=String(item?.mid||'');if(!/^[1-9]\\d{0,24}$/.test(id)){invalidCount++;continue;}if(ids.has(id))continue;ids.add(id);added++;creators.push({platform:'bilibili',platformUserId:id,name:item.uname||'哔站博主',profileUrl:'https://space.bilibili.com/'+id,avatarUrl:item.face||undefined});}",
    "console.log('哔站关注提取进度',creators.length,'/',total);",
    "if(creators.length>=total)break;if(!list.length||!added)throw new Error('哔站关注分页未返回新记录');await sleep(1500);}",
    "if(total===null)throw new Error('哔站没有返回关注总数');",
    "if(creators.length!==total)throw new Error('哔站关注分页达到上限，未完整提取');",
    "}catch(error){if(total===null||!creators.length)throw error;message=error instanceof Error?error.message:'分页失败';}",
    "const bridgePayload={account:{id:uid,name:nav.data.uname||'哔站账号'},creators,total,invalidCount,message};",
    "await new Promise((resolve,reject)=>{let timer,interval;const cleanup=()=>{clearTimeout(timer);clearInterval(interval);window.removeEventListener('message',onAck);};const onAck=event=>{if(event.origin!==appOrigin||event.source!==bridgeWindow||event.data?.type!=='following-list-ack'||event.data?.token!==bridgeToken)return;cleanup();event.data.ok?resolve():reject(new Error(event.data.error||'本站连接失败'));};const send=()=>{if(bridgeWindow.closed){cleanup();reject(new Error('本站连接页已关闭'));return;}bridgeWindow.postMessage({type:'following-list',token:bridgeToken,payload:bridgePayload},appOrigin);};window.addEventListener('message',onAck);timer=setTimeout(()=>{cleanup();reject(new Error('本站连接超时，请重新发起连接'));},30000);interval=setInterval(send,500);send();});",
    "console.log(message?'关注名单部分发送到本站，请切回关注列表窗口查看结果':'关注名单已发送到本站，请切回关注列表窗口查看结果');",
    "}catch(error){bridgeWindow?.close();console.error('关注名单提取失败',error);alert(error instanceof Error?error.message:'关注名单提取失败');}})();",
  ].join("\n");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Validate the dedicated list format; never accept a whole-site backup here. */
export function parseFollowingFile(value: unknown): FollowingFile {
  const root = record(value);
  const invalid = () => new Error("名单文件格式无效，请选择工具导出的 following-list JSON 文件");
  if (root.kind !== "following-list" || root.version !== 1 || !Array.isArray(root.creators)
    || root.creators.length > FOLLOWING_LIMIT * 2 || !Array.isArray(root.platformResults)
    || root.platformResults.length > 2 || typeof root.exportedAt !== "string" || !Number.isFinite(Date.parse(root.exportedAt))) throw invalid();
  const creators = new Map<string, FollowingCreator>();
  for (const value of root.creators) {
    const item = record(value);
    if (!isFollowingPlatform(item.platform) || !validFollowingId(item.platform, item.platformUserId)
      || typeof item.name !== "string" || item.name.length > 80
      || item.profileUrl !== followingProfileUrl(item.platform, item.platformUserId)) throw invalid();
    const avatarUrl = followingAvatar(item.avatarUrl);
    const creator: FollowingCreator = {
      platform: item.platform, platformUserId: item.platformUserId,
      name: cleanFollowingName(item.name, item.platform), profileUrl: item.profileUrl,
      ...(avatarUrl ? { avatarUrl } : {}),
    };
    const key = followingKey(creator);
    if (!creators.has(key)) creators.set(key, creator);
  }
  const seenPlatforms = new Set<Platform>();
  const platformResults = root.platformResults.map((value): FollowingResult => {
    const item = record(value);
    const validCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (!isFollowingPlatform(item.platform) || seenPlatforms.has(item.platform)
      || !["complete", "partial", "error", "cancelled"].includes(String(item.status))
      || !validCount(item.received) || Number(item.received) > FOLLOWING_LIMIT || !validCount(item.invalidCount)
      || (item.total !== undefined && !validCount(item.total))) throw invalid();
    seenPlatforms.add(item.platform);
    const count = [...creators.values()].filter((creator) => creator.platform === item.platform).length;
    if (count > Number(item.received) || (item.status === "complete" && (Number(item.invalidCount) !== 0
      || (item.total !== undefined && item.total !== item.received)))) throw invalid();
    return {
      platform: item.platform, status: item.status as FollowingResult["status"],
      received: item.received as number, invalidCount: item.invalidCount as number,
      ...(item.total === undefined ? {} : { total: item.total as number }),
      ...(typeof item.code === "string" ? { code: item.code.slice(0, 80) } : {}),
      ...(typeof item.message === "string" ? { message: item.message.slice(0, 300) } : {}),
    };
  });
  if ([...creators.values()].some((creator) => !seenPlatforms.has(creator.platform))) throw invalid();
  return { kind: "following-list", version: 1, exportedAt: root.exportedAt, creators: [...creators.values()], platformResults };
}

/** Incremental UTF-8 decoding also handles a JSON line split across network chunks. */
export async function readFollowingStream(response: Response, onEvent: (event: FollowingEvent) => void, signal: AbortSignal) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || "关注名单提取请求失败，请重试");
  }
  if (!response.body) throw new Error("提取服务没有返回数据流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let done = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as FollowingEvent;
    if (!["account", "page", "result", "error", "done"].includes(event.type) || done) throw new Error("提取服务返回了异常数据流");
    if (event.type === "error") throw new Error(event.error || "关注名单提取失败");
    if (event.type === "done") done = true;
    onEvent(event);
  };
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > FOLLOWING_FILE_BYTES) throw new Error("提取服务返回的数据超出上限");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (chunk.done) break;
    }
    if (buffer.trim()) {
      try {
        consume(buffer);
      } catch (error) {
        // A stream cut in the middle of a line must read as "interrupted", not as a
        // raw JSON parse error from the transport.
        if (!done && error instanceof SyntaxError) {
          throw new Error("连接提前结束，已获取的名单保留为未完整结果");
        }
        throw error;
      }
    }
    if (!done) throw new Error("连接提前结束，已获取的名单保留为未完整结果");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
