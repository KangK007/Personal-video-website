import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import {
  acquireLaunchLock,
  projectRoot,
  readManagedPid,
  runtimeRoot,
  stopManagedProcess,
  writeManagedPid,
} from "./local-process.mjs";

const localRoot = path.join(projectRoot, ".local");
const personalDataBackupRoot = path.join(localRoot, "personal-data", "backups");
const sidecarRoot = path.join(localRoot, "Douyin_TikTok_Download_API");
const sidecarPython = path.join(sidecarRoot, ".venv", "Scripts", "python.exe");
const sidecarEntry = path.join(projectRoot, "scripts", "sidecar-entry.py");
const sidecarSupervisor = path.join(projectRoot, "scripts", "sidecar-supervisor.mjs");
const appMarker = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const settings = JSON.parse(readFileSync(path.join(projectRoot, "scripts", "local-settings.json"), "utf8"));
const forceBuild = process.argv.includes("--build");

function resolvePort(environmentName, fallback) {
  const value = Number(process.env[environmentName] || fallback);
  if (!Number.isInteger(value) || value <= 0 || value >= 65_536) {
    throw new Error(`${environmentName} 必须是 1-65535 的整数`);
  }
  return value;
}

const appPort = resolvePort("APP_PORT", settings.appPort);
const sidecarPort = resolvePort("SIDECAR_PORT", settings.sidecarPort);
const bilibiliCookieFile = path.resolve(
  projectRoot,
  process.env.BILIBILI_COOKIE_FILE || ".local/bilibili-cookie.txt",
);
const sidecarTokenFile = path.join(localRoot, "sidecar-token.txt");

function sidecarPythonIsUsable() {
  if (!existsSync(sidecarPython)) return false;
  try {
    const version = execFileSync(
      sidecarPython,
      ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return version === "3.11";
  } catch {
    return false;
  }
}

function readSidecarToken() {
  if (!existsSync(sidecarTokenFile)) {
    return "";
  }
  const value = readFileSync(sidecarTokenFile, "utf8").trim();
  if (value.length < 32 || /[\r\n]/.test(value)) {
    throw new Error("本机抓取服务令牌格式无效，请重新运行 scripts/setup-sidecar.ps1");
  }
  return value;
}

const sidecarToken = readSidecarToken();

mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(personalDataBackupRoot, { recursive: true });

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor !== 24) {
  console.warn(
    `警告：当前使用 Node.js ${process.versions.node}，本项目验证版本为 Node.js 24 LTS。将继续启动；如遇异常，请先切换到 Node.js 24。`,
  );
}

function logTail(filePath) {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8").split(/\r?\n/).slice(-30).join("\n");
}

async function endpointIsReady(url, validator) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) return false;
    return Boolean(validator(await response.json()));
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const appIsReady = (url) => endpointIsReady(url, (payload) => payload?.ok === true && payload?.services);
async function sidecarIsReady(baseUrl) {
  if (!(await endpointIsReady(`${baseUrl}/openapi.json`, (payload) => typeof payload?.openapi === "string" && payload?.info))) {
    return false;
  }
  const probeUrl = `${baseUrl}/__local_auth_probe__`;
  try {
    const unauthenticated = await fetch(probeUrl, { cache: "no-store" });
    const authenticated = await fetch(probeUrl, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${sidecarToken}` },
    });
    return unauthenticated.status === 401 && authenticated.status !== 401;
  } catch {
    return false;
  }
}

async function waitFor(check, seconds = 30) {
  const deadline = Date.now() + seconds * 1_000;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

// A cold uvicorn start is usually a few seconds, but the first launch after a stop
// can lose the port race while the previous worker is still exiting. Give the
// supervisor room to restart the worker before reporting the sidecar as unavailable.
const SIDECAR_READY_TIMEOUT_SECONDS = 90;

function spawnDetached(name, command, args, cwd, stdoutPath, stderrPath, env = process.env) {
  const stdout = openSync(stdoutPath, "w");
  const stderr = openSync(stderrPath, "w");
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      detached: true,
      windowsHide: true,
      env,
      stdio: ["ignore", stdout, stderr],
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  if (!child.pid) throw new Error(`无法启动${name}`);
  writeManagedPid(name, child.pid);
  child.unref();
  return child.pid;
}

function newestMtime(target) {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(target, { withFileTypes: true }).reduce((latest, entry) => {
    if (entry.isSymbolicLink()) return latest;
    return Math.max(latest, newestMtime(path.join(target, entry.name)));
  }, stat.mtimeMs);
}

function buildIsStale() {
  const buildId = path.join(projectRoot, ".next", "BUILD_ID");
  if (!existsSync(buildId)) return true;
  const inputs = [
    "app",
    "components",
    "lib",
    "public",
    "package.json",
    "package-lock.json",
    ".env.local",
    "next.config.mjs",
    "tsconfig.json",
  ];
  const newestInput = Math.max(...inputs.map((entry) => newestMtime(path.join(projectRoot, entry))));
  return newestInput > statSync(buildId).mtimeMs;
}

function runBuild() {
  execFileSync(process.execPath, [appMarker, "build"], { cwd: projectRoot, stdio: "inherit" });
}

async function main() {
  const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
  const appUrl = `http://127.0.0.1:${appPort}`;
  const sidecarLog = path.join(runtimeRoot, "sidecar.log");
  const sidecarErrorLog = path.join(runtimeRoot, "sidecar-error.log");
  const appLog = path.join(runtimeRoot, "app.log");
  const appErrorLog = path.join(runtimeRoot, "app-error.log");

  let sidecarReady = sidecarToken ? await sidecarIsReady(sidecarUrl) : false;
  const sidecarPythonReady = sidecarPythonIsUsable();
  const sidecarResponding = await endpointIsReady(`${sidecarUrl}/openapi.json`, (payload) => typeof payload?.openapi === "string" && payload?.info);
  if (!sidecarToken && (sidecarResponding || sidecarPythonReady)) {
    throw new Error("已检测到本机抓取服务，但缺少访问令牌。请先运行 scripts/setup-sidecar.ps1");
  }
  if (sidecarResponding && !sidecarReady && !readManagedPid("sidecar", sidecarSupervisor)) {
    throw new Error("检测到未由本项目管理或令牌不匹配的本机抓取服务。请先手动关闭该进程再重试。");
  }
  if (!sidecarReady && sidecarPythonReady) {
    if (readManagedPid("sidecar", sidecarSupervisor)) {
      await stopManagedProcess("sidecar", sidecarSupervisor);
    }
    console.log("正在启动本机抓取服务...");
    spawnDetached(
      "sidecar",
      process.execPath,
      [sidecarSupervisor, sidecarPython, sidecarEntry, "--sidecar-root", sidecarRoot, "--cookie-file", bilibiliCookieFile, "--token-file", sidecarTokenFile, "--port", String(sidecarPort)],
      projectRoot,
      sidecarLog,
      sidecarErrorLog,
    );
    sidecarReady = await waitFor(() => sidecarIsReady(sidecarUrl), SIDECAR_READY_TIMEOUT_SECONDS);
  }
  if (!sidecarReady) {
    // Keep the managed supervisor alive: it keeps retrying the worker, so the site
    // recovers as soon as the sidecar finishes starting instead of staying down.
    const supervisorRunning = Boolean(readManagedPid("sidecar", sidecarSupervisor));
    const setupHint = existsSync(sidecarPython) && !sidecarPythonReady
      ? "Python 3.11 虚拟环境不可运行，请重新运行 scripts/setup-sidecar.ps1。"
      : supervisorRunning
        ? "监督器仍在后台重试，稍后会自动就绪；也可查看 .local/runtime 日志。"
        : "详情见 .local/runtime 日志。";
    console.warn(`警告：哔站本机抓取服务在 ${SIDECAR_READY_TIMEOUT_SECONDS} 秒内未就绪，网站仍会启动；${setupHint}`);
  }

  let appReady = await appIsReady(`${appUrl}/api/health`);
  const needsBuild = forceBuild || buildIsStale();
  const appPid = readManagedPid("app", appMarker);
  if (appReady && needsBuild) {
    if (!appPid) {
      throw new Error("检测到需要重建，但当前网站不是由本启动器管理。请先关闭现有网站进程再重试。");
    }
    console.log("正在停止旧网站并重新构建...");
    await stopManagedProcess("app", appMarker);
    await waitFor(async () => !(await appIsReady(`${appUrl}/api/health`)), 5);
    appReady = false;
  } else if (!appReady && appPid) {
    await stopManagedProcess("app", appMarker);
  }

  if (!appReady && needsBuild) {
    console.log("正在构建网站...");
    runBuild();
  }
  if (!appReady) {
    console.log("正在启动网站...");
    spawnDetached(
      "app",
      process.execPath,
      [appMarker, "start", "--hostname", "127.0.0.1", "--port", String(appPort)],
      projectRoot,
      appLog,
      appErrorLog,
      { ...process.env, APP_PORT: String(appPort), SIDECAR_PORT: String(sidecarPort), FEED_SIDECAR_URL: sidecarUrl, FEED_SIDECAR_TOKEN: sidecarToken },
    );
    if (!(await waitFor(() => appIsReady(`${appUrl}/api/health`)))) {
      if (readManagedPid("app", appMarker)) await stopManagedProcess("app", appMarker);
      throw new Error(`网站启动失败。\n${logTail(appErrorLog)}\n${logTail(appLog)}`);
    }
  }

  console.log(`网站已就绪：http://127.0.0.1:${appPort}`);
  console.log(`健康检查：http://127.0.0.1:${appPort}/api/health`);
  console.log(`运行日志：${runtimeRoot}`);
  if (!sidecarReady) console.log("提示：哔站同步暂时不可用，抖音与本地数据功能仍可使用；若监督器仍在运行，它会继续自动重试。");
}

async function runWithLaunchLock() {
  const releaseLock = await acquireLaunchLock();
  try {
    await main();
  } finally {
    await releaseLock();
  }
}

runWithLaunchLock().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
