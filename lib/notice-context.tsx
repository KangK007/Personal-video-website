"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type NoticeKind = "success" | "error" | "info";

export type NoticeAction = {
  label: string;
  onClick: () => void;
};

export type NoticeInput = {
  kind: NoticeKind;
  text: string;
  action?: NoticeAction;
};

export type Notice = NoticeInput & {
  id: string;
  duration: number;
};

type NoticeContextValue = {
  notice: Notice | null;
  showNotice: (input: NoticeInput, duration?: number) => string;
  clearNotice: (id?: string) => void;
  clearAllNotices: () => void;
};

const DEFAULT_NOTICE_DURATION = 10_000;
// Keep a short backlog: a deferred notice can carry an undo action, so it must not
// be silently overwritten by the next operation's toast.
const MAX_QUEUED_NOTICES = 3;
const NoticeContext = createContext<NoticeContextValue | null>(null);
let noticeSequence = 0;

function createNoticeId(): string {
  noticeSequence += 1;
  return `${Date.now()}-${noticeSequence}`;
}

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentNoticeRef = useRef<Notice | null>(null);
  const queuedNoticesRef = useRef<Notice[]>([]);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const clearNotice = useCallback((id?: string) => {
    const current = currentNoticeRef.current;
    if (!current || (id !== undefined && current.id !== id)) {
      if (id !== undefined) {
        queuedNoticesRef.current = queuedNoticesRef.current.filter((item) => item.id !== id);
      }
      return;
    }
    clearTimer();
    const next = queuedNoticesRef.current.shift() ?? null;
    currentNoticeRef.current = next;
    setNotice(next);
  }, [clearTimer]);

  const clearAllNotices = useCallback(() => {
    clearTimer();
    queuedNoticesRef.current = [];
    currentNoticeRef.current = null;
    setNotice(null);
  }, [clearTimer]);

  const showNotice = useCallback((input: NoticeInput, duration?: number) => {
    const effectiveDuration = duration ?? (input.kind === "error" ? 0 : DEFAULT_NOTICE_DURATION);
    const nextNotice = { ...input, id: createNoticeId(), duration: effectiveDuration };
    if (currentNoticeRef.current?.action) {
      queuedNoticesRef.current.push(nextNotice);
      if (queuedNoticesRef.current.length > MAX_QUEUED_NOTICES) {
        queuedNoticesRef.current.splice(0, queuedNoticesRef.current.length - MAX_QUEUED_NOTICES);
      }
      return nextNotice.id;
    }
    clearTimer();
    currentNoticeRef.current = nextNotice;
    setNotice(nextNotice);
    return nextNotice.id;
  }, [clearTimer]);

  useEffect(() => {
    clearTimer();
    if (!notice || notice.duration <= 0) return;
    timerRef.current = setTimeout(() => clearNotice(notice.id), notice.duration);
    return clearTimer;
  }, [clearNotice, clearTimer, notice]);

  const value = useMemo(() => ({ notice, showNotice, clearNotice, clearAllNotices }), [clearAllNotices, clearNotice, notice, showNotice]);
  return <NoticeContext.Provider value={value}>{children}</NoticeContext.Provider>;
}

export function useNotice(): NoticeContextValue {
  const context = useContext(NoticeContext);
  if (!context) throw new Error("useNotice 必须在 NoticeProvider 内使用");
  return context;
}
