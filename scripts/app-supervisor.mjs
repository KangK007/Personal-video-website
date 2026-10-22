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
    restartDelayMs = lifetimeMs >= 30_000 ? 500 : Math.min(restartDelayMs * 2, 10_000);
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
