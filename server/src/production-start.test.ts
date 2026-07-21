import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) terminate(child, "SIGKILL");
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("production server package runtime", () => {
  it("installs a clean source workspace with lifecycle scripts enabled", { timeout: 45_000 }, async () => {
    const workspace = copyCleanWorkspace("flowgate-source-install-");

    await execFileAsync("npm", ["install", "--offline", "--no-audit", "--no-fund"], {
      cwd: workspace, timeout: 30_000
    });

    expect(readFileSync(resolve(workspace, "server/dist/native/pilot-atomic-publish.c"), "utf8"))
      .toContain("publish_no_replace");
  });

  it("starts from a clean build through the published shared runtime", { timeout: 45_000 }, async () => {
    const workspace = copyCleanWorkspace("flowgate-production-workspace-");
    await execFileAsync("npm", ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], {
      cwd: workspace, timeout: 30_000
    });
    await execFileAsync("npm", ["run", "build"], { cwd: workspace, timeout: 30_000 });
    const dataDir = mkdtempSync(resolve(tmpdir(), "flowgate-production-start-"));
    directories.push(dataDir);
    const child = spawn("npm", ["start", "-w", "server"], {
      cwd: workspace,
      detached: process.platform !== "win32",
      env: { ...process.env, DATA_DIR: dataDir, PORT: "0", AUTOMATION_WORKER_ENABLED: "false" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(child);
    const started = await waitForListening(child);
    expect(started.stdout).toContain("FLOWGATE_LISTENING");
    expect(started.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    const sharedPackage = JSON.parse(readFileSync(resolve(workspace, "shared/package.json"), "utf8"));
    expect(sharedPackage.exports).toMatchObject({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }
    });
    const { stdout: packedOutput } = await execFileAsync(
      "npm", ["pack", "--dry-run", "--json", "-w", "shared"], { cwd: workspace, timeout: 15_000 }
    );
    const packed = JSON.parse(packedOutput)[0].files.map((file: { path: string }) => file.path);
    expect(packed).toContain("dist/index.js");
    expect(packed).toContain("dist/domain.js");

    const packageDir = resolve(workspace, "packages");
    mkdirSync(packageDir);
    const sharedPack = await packWorkspace(workspace, packageDir, "shared");
    const serverPack = await packWorkspace(workspace, packageDir, "server");
    const sharedFiles = sharedPack.files.map((file) => file.path);
    const serverFiles = serverPack.files.map((file) => file.path);
    expect(sharedFiles).toContain("dist/index.js");
    expect(sharedFiles.some((path) => path.includes(".test."))).toBe(false);
    expect(serverFiles).toContain("dist/index.js");
    expect(serverFiles).toContain("dist/native/pilot-atomic-publish");
    expect(serverFiles).toContain("dist/native/pilot-atomic-publish.c");
    expect(serverFiles).toContain("dist/native/install-pilot-atomic-publish.mjs");
    expect(serverFiles).toContain("install-pilot-atomic-publish.mjs");
    expect(serverFiles.every((path) => path === "package.json"
      || path === "install-pilot-atomic-publish.mjs" || path.startsWith("dist/"))).toBe(true);
    expect(serverFiles.some((path) => path.startsWith("src/") || path.startsWith("scripts/")
      || path.startsWith("native/"))).toBe(false);

    const installedApp = resolve(workspace, "installed-app");
    mkdirSync(installedApp);
    writeFileSync(resolve(installedApp, "package.json"), JSON.stringify({
      name: "flowgate-installed-smoke", private: true, type: "module",
      dependencies: {
        "@ai-workflow/shared": `file:${resolve(packageDir, sharedPack.filename)}`,
        "@ai-workflow/server": `file:${resolve(packageDir, serverPack.filename)}`
      }
    }));
    const installBin = resolve(installedApp, "install-bin");
    mkdirSync(installBin, { mode: 0o700 });
    const compiler = resolve(installBin, "cc");
    writeFileSync(compiler, `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift
done
printf 'installed-target-helper' > "$out"
`);
    chmodSync(compiler, 0o700);
    await execFileAsync("npm", ["install", "--offline", "--no-audit", "--no-fund"], {
      cwd: installedApp, timeout: 30_000,
      env: { ...process.env, PATH: `${installBin}:${process.env.PATH ?? "/usr/bin:/bin"}` }
    });
    const installedNative = resolve(installedApp, "node_modules/@ai-workflow/server/dist/native");
    const installedHelper = resolve(installedNative, "pilot-atomic-publish");
    expect(readFileSync(installedHelper, "utf8")).toBe("installed-target-helper");
    const installerUrl = pathToFileURL(resolve(installedNative, "install-pilot-atomic-publish.mjs")).href;
    const unsupported = await execFileAsync(process.execPath, ["--input-type=module", "-e",
      `import { installPilotAtomicPublish } from ${JSON.stringify(installerUrl)};
       await installPilotAtomicPublish({ platform: "freebsd" });`
    ], { cwd: installedApp, timeout: 10_000 });
    expect(unsupported.stderr.trim()).toBe(
      'FLOWGATE_PILOT_HELPER_UNAVAILABLE {"reason":"unsupported_platform","platform":"freebsd"}'
    );
    expect(() => readFileSync(installedHelper)).toThrow();
    const installedDataDir = mkdtempSync(resolve(tmpdir(), "flowgate-installed-start-"));
    directories.push(installedDataDir);
    const installedChild = spawn(process.execPath, [
      resolve(installedApp, "node_modules/@ai-workflow/server/dist/index.js")
    ], {
      cwd: installedApp,
      detached: process.platform !== "win32",
      env: { ...process.env, DATA_DIR: installedDataDir, PORT: "0", AUTOMATION_WORKER_ENABLED: "false" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(installedChild);
    expect((await waitForListening(installedChild)).stdout).toContain("FLOWGATE_LISTENING");
    terminate(installedChild, "SIGTERM");
    const installedExit = await waitForExit(installedChild);
    expect(installedExit.signal === "SIGTERM" || installedExit.code === 0).toBe(true);
    children.splice(children.indexOf(installedChild), 1);

    const noCompilerApp = resolve(workspace, "installed-app-no-compiler");
    mkdirSync(noCompilerApp);
    writeFileSync(resolve(noCompilerApp, "package.json"), JSON.stringify({
      name: "flowgate-no-compiler-smoke", private: true, type: "module",
      dependencies: {
        "@ai-workflow/shared": `file:${resolve(packageDir, sharedPack.filename)}`,
        "@ai-workflow/server": `file:${resolve(packageDir, serverPack.filename)}`
      }
    }));
    const failingBin = resolve(noCompilerApp, "install-bin");
    mkdirSync(failingBin, { mode: 0o700 });
    writeFileSync(resolve(failingBin, "cc"), "#!/bin/sh\nexit 1\n");
    chmodSync(resolve(failingBin, "cc"), 0o700);
    await execFileAsync("npm", ["install", "--offline", "--no-audit", "--no-fund"], {
      cwd: noCompilerApp, timeout: 30_000,
      env: { ...process.env, PATH: `${failingBin}:${process.env.PATH ?? "/usr/bin:/bin"}` }
    });
    const noCompilerHelper = resolve(
      noCompilerApp, "node_modules/@ai-workflow/server/dist/native/pilot-atomic-publish"
    );
    expect(() => readFileSync(noCompilerHelper)).toThrow();
    const noCompilerDataDir = mkdtempSync(resolve(tmpdir(), "flowgate-no-compiler-start-"));
    directories.push(noCompilerDataDir);
    const noCompilerChild = spawn(process.execPath, [
      resolve(noCompilerApp, "node_modules/@ai-workflow/server/dist/index.js")
    ], {
      cwd: noCompilerApp,
      detached: process.platform !== "win32",
      env: { ...process.env, DATA_DIR: noCompilerDataDir, PORT: "0", AUTOMATION_WORKER_ENABLED: "false" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(noCompilerChild);
    expect((await waitForListening(noCompilerChild)).stdout).toContain("FLOWGATE_LISTENING");
    terminate(noCompilerChild, "SIGTERM");
    const noCompilerExit = await waitForExit(noCompilerChild);
    expect(noCompilerExit.signal === "SIGTERM" || noCompilerExit.code === 0).toBe(true);
    children.splice(children.indexOf(noCompilerChild), 1);

    terminate(child, "SIGTERM");
    const exit = await waitForExit(child);
    expect(exit.signal === "SIGTERM" || exit.code === 0).toBe(true);
    children.splice(children.indexOf(child), 1);
  });
});

function copyCleanWorkspace(prefix: string) {
  const workspace = mkdtempSync(resolve(tmpdir(), prefix));
  directories.push(workspace);
  for (const path of ["package.json", "package-lock.json", "tsconfig.base.json", "shared", "server", "web"]) {
    cpSync(resolve(root, path), resolve(workspace, path), {
      recursive: true,
      filter: (source) => !source.split("/").some((segment) => segment === "dist" || segment === "node_modules")
    });
  }
  return workspace;
}

async function packWorkspace(workspace: string, destination: string, name: "shared" | "server") {
  const { stdout } = await execFileAsync(
    "npm", ["pack", "--json", "--pack-destination", destination, "-w", name],
    { cwd: workspace, timeout: 30_000 }
  );
  return JSON.parse(stdout)[0] as {
    filename: string;
    files: Array<{ path: string; mode: number }>;
  };
}

function waitForListening(child: ChildProcess) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`PRODUCTION_START_TIMEOUT\n${stdout}\n${stderr}`)), 10_000);
    const finish = () => {
      if (!stdout.includes("FLOWGATE_LISTENING")) return;
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr });
    };
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); finish(); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`PRODUCTION_START_EXITED:${code}:${signal}\n${stdout}\n${stderr}`));
    });
  });
}

function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("PRODUCTION_STOP_TIMEOUT")), 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });
  });
}

function terminate(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}
