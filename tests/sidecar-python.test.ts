import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "sidecar-python-"));
const helperPath = path.resolve("scripts/sidecar-python.ps1");

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function powershellLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function createPythonStub(name: string, version: string, exitCode = 0) {
  const stubPath = path.join(fixtureRoot, `${name}.cmd`);
  writeFileSync(stubPath, `@echo off\r\nif not "%~1"=="-c" exit /b 4\r\necho ${version}\r\nexit /b ${exitCode}\r\n`);
  return stubPath;
}

function probePython(pythonPath: string) {
  const command = `. ${powershellLiteral(helperPath)}; if (Test-SidecarPython ${powershellLiteral(pythonPath)}) { 'valid' } else { 'invalid' }`;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

describe.skipIf(process.platform !== "win32")("sidecar Python validation", () => {
  it("accepts a working Python 3.11 interpreter", () => {
    expect(probePython(createPythonStub("valid", "3.11"))).toBe("valid");
  });

  it("rejects an existing but unlaunchable interpreter", () => {
    expect(probePython(createPythonStub("broken", "3.11", 103))).toBe("invalid");
  });

  it("rejects an interpreter with the wrong Python version", () => {
    expect(probePython(createPythonStub("wrong-version", "3.12"))).toBe("invalid");
  });
});
