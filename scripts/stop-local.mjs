import path from "node:path";
import {
  acquireLaunchLock,
  projectRoot,
  stopManagedProcess,
} from "./local-process.mjs";

const appMarker = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const sidecarSupervisorMarker = path.join(projectRoot, "scripts", "sidecar-supervisor.mjs");
const sidecarWorkerMarker = path.join(projectRoot, "scripts", "sidecar-entry.py");

const releaseLock = await acquireLaunchLock();
try {
  const appStopped = await stopManagedProcess("app", appMarker);
  const supervisorStopped = await stopManagedProcess("sidecar", sidecarSupervisorMarker);
  const workerStopped = await stopManagedProcess("sidecar-worker", sidecarWorkerMarker);
  const sidecarStopped = supervisorStopped || workerStopped;

  if (!appStopped && !sidecarStopped) {
    console.log("没有发现由本项目启动且仍在运行的服务。");
  } else {
    if (appStopped) console.log("网站已停止。");
    if (sidecarStopped) console.log("本机抓取服务已停止。");
  }
} finally {
  await releaseLock();
}
