import path from "node:path";
import {
  acquireLaunchLock,
  projectRoot,
  stopManagedProcess,
} from "./local-process.mjs";

const appMarker = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const appSupervisorMarker = path.join(projectRoot, "scripts", "app-supervisor.mjs");
const sidecarSupervisorMarker = path.join(projectRoot, "scripts", "sidecar-supervisor.mjs");
const sidecarWorkerMarker = path.join(projectRoot, "scripts", "sidecar-entry.py");

const releaseLock = await acquireLaunchLock();
try {
  const appStopped = await stopManagedProcess("app", appSupervisorMarker);
  const appWorkerStopped = await stopManagedProcess("app-worker", appMarker);
  const supervisorStopped = await stopManagedProcess("sidecar", sidecarSupervisorMarker);
  const workerStopped = await stopManagedProcess("sidecar-worker", sidecarWorkerMarker);
  const sidecarStopped = supervisorStopped || workerStopped;

  if (!appStopped && !appWorkerStopped && !sidecarStopped) {
    console.log("没有发现由本项目启动且仍在运行的服务。");
  } else {
    if (appStopped || appWorkerStopped) console.log("网站已停止。");
    if (sidecarStopped) console.log("本机抓取服务已停止。");
  }
} finally {
  await releaseLock();
}
