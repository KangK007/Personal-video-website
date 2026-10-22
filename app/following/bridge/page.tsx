"use client";

import { useEffect, useState } from "react";

const BILIBILI_ORIGINS = new Set(["https://api.bilibili.com", "https://www.bilibili.com", "https://bilibili.com"]);

export default function FollowingBridgePage() {
  const [message, setMessage] = useState("等待哔站关注名单...");

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
    const opener = window.opener;
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token) || !opener) {
      setMessage("连接已失效，请从本站关注列表重新发起");
      return;
    }
    let receiving = false;
    const receive = async (event: MessageEvent) => {
      if (receiving || event.source !== opener || !BILIBILI_ORIGINS.has(event.origin)
        || event.data?.type !== "following-list" || event.data?.token !== token) return;
      receiving = true;
      try {
        const response = await fetch("/api/following/bridge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, payload: event.data.payload }),
        });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error || "名单接收失败");
        opener.postMessage({ type: "following-list-ack", token, ok: true }, event.origin);
        setMessage("名单已传回本站，正在关闭此标签页");
        window.setTimeout(() => window.close(), 600);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "名单接收失败";
        opener.postMessage({ type: "following-list-ack", token, ok: false, error: reason }, event.origin);
        setMessage(reason);
        receiving = false;
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  return <main className="bridge-page"><h1>哔站关注名单</h1><p role="status" aria-live="polite">{message}</p></main>;
}
