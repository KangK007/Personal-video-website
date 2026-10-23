import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const supervisorSource = path.join(repoRoot, "scripts", "app-supervisor.mjs");

function runSupervisor(maxRapidFailures: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "app-supervisor-"));
  const supervisor = path.join(dir, "app-supervisor.mjs");
  copyFileSync(supervisorSource, supervisor);
  writeFileSync(path.join(dir, "local-process.mjs"), [
    "export const projectRoot = process.cwd();",
    "export function writeManagedPid() {}",
    "",
  ].join("\n"));
  const runsFile = path.join(dir, "runs.log");
  const worker = path.join(dir, "worker-stub.mjs");
  writeFileSync(worker, [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(runsFile)}, 'run\\n');`,
    "process.exitCode = 1;",
    "",
  ].join("\n"));

  const child = spawn(process.execPath, [supervisor, worker], {
    cwd: dir,
    env: { ...process.env, APP_SUPERVISOR_MAX_RAPID_FAILURES: String(maxRapidFailures) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });
  return { child, exited, stderr: () => stderr, runsFile, dir };
}

describe("app supervisor", () => {
  it("stops after repeated rapid startup failures instead of restarting forever", async () => {
    const run = runSupervisor(2);
    try {
      const exitCode = await Promise.race([
        run.exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20_000)),
      ]);
      if (exitCode === "timeout") run.child.kill("SIGKILL");
      expect(exitCode).toBe(1);
      expect(run.stderr()).toContain("已停止自动重启");
      const runs = existsSync(run.runsFile) ? readFileSync(run.runsFile, "utf8").trim().split("\n") : [];
      expect(runs).toHaveLength(2);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  }, 30_000);
});
