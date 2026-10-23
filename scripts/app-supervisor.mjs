import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { projectRoot, writeManagedPid } from "./local-process.mjs";

const [nextExecutable, ...nextArgs] = process.argv.slice(2);
if (!nextExecutable) {
  throw new Error("网站监督器缺少 Next.js 启动参数");
}

const resolvedExecutable = path.resolve(nextExecutable);
if (!existsSync(resolvedExecutable)) {
  throw new Error("Next.js 启动文件不存在，请重新安装依赖");
}

let worker = null;
let restartTimer = null;
let restartDelayMs = 500;
let stopping = false;
// A worker that never survives startup cannot be fixed by restarting it forever;
// give up after a few rapid failures so the user sees one actionable error.
const MAX_RAPID_FAILURES = Math.min(
  Math.max(Number.parseInt(process.env.APP_SUPERVISOR_MAX_RAPID_FAILURES ?? "", 10) || 5, 1),
  20,
);
let rapidFailures = 0;

function launchWorker() {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [resolvedExecutable, ...nextArgs], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  worker = child;
  if (child.pid) writeManagedPid("app-worker", child.pid);

  child.once("error", (error) => {
    console.error(`网站启动失败：${error.message}`);
  });
  child.once("close", (code, signal) => {
    if (worker === child) worker = null;
    if (stopping) return;

    const lifetimeMs = Date.now() - startedAt;
    if (lifetimeMs >= 30_000) {
      rapidFailures = 0;
      restartDelayMs = 500;
    } else {
      rapidFailures += 1;
      if (rapidFailures >= MAX_RAPID_FAILURES) {
        console.error(
          `网站连续 ${MAX_RAPID_FAILURES} 次启动后立即退出，已停止自动重启。请查看 .local/runtime 下的日志并修复后运行 npm run start:local。`,
        );
        process.exit(1);
      }
      restartDelayMs = Math.min(restartDelayMs * 2, 10_000);
    }
    console.error(
      `网站进程意外退出（${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}），将在 ${restartDelayMs} ms 后重启。`,
    );
    restartTimer = setTimeout(launchWorker, restartDelayMs);
  });
}

function stopSupervisor() {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (!worker) {
    process.exit(0);
    return;
  }

  const child = worker;
  const forceTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } finally {
      process.exit(0);
    }
  }, 5_000);
  child.once("close", () => {
    clearTimeout(forceTimer);
    process.exit(0);
  });
  child.kill();
}

process.once("SIGINT", stopSupervisor);
process.once("SIGTERM", stopSupervisor);
process.once("SIGHUP", stopSupervisor);

launchWorker();
