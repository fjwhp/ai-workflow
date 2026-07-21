import { execFile } from "node:child_process";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicPilotPublish } from "./pilot-atomic-publish.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("atomic pilot publisher", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "uses the current platform syscall to publish once without replacing an owner",
    async () => {
      const parent = temporaryDirectory("flowgate-atomic-publish-real-");
      const source = join(parent, "source");
      const target = join(parent, "target");
      mkdirSync(source);
      writeFileSync(join(source, "ready.txt"), "ready");

      await atomicPilotPublish(source, target);
      expect(readFileSync(join(target, "ready.txt"), "utf8")).toBe("ready");

      const second = join(parent, "second");
      mkdirSync(second);
      const owned = lstatSync(target);
      await expect(atomicPilotPublish(second, target)).rejects.toThrow("PILOT_PUBLISH_CONFLICT");
      expect(lstatSync(target)).toMatchObject({ dev: owned.dev, ino: owned.ino });
      expect(lstatSync(second).isDirectory()).toBe(true);
    }
  );

  it("passes exact argv through a simulated Linux executor with shell disabled", async () => {
    const parent = temporaryDirectory("flowgate-atomic-publish-linux-");
    const source = join(parent, "source");
    const target = join(parent, "target");
    const helper = trustedFakeHelper(parent);
    const execute = vi.fn(async () => {});

    await atomicPilotPublish(source, target, { platform: "linux", helperPath: helper, execute });

    expect(execute).toHaveBeenCalledWith(helper, [source, target], expect.objectContaining({ shell: false }));
  });

  it.each([
    [10, "PILOT_PUBLISH_CONFLICT"],
    [11, "PILOT_ATOMIC_PUBLISH_UNAVAILABLE"],
    [12, "PILOT_PUBLISH_FAILED"],
    [64, "PILOT_ATOMIC_PUBLISH_UNAVAILABLE"]
  ])("maps helper exit %i to %s", async (exitCode, expected) => {
    const parent = temporaryDirectory("flowgate-atomic-publish-exit-");
    const helper = trustedFakeHelper(parent);
    const execute = vi.fn(async () => { throw Object.assign(new Error("helper failed"), { code: exitCode }); });

    await expect(atomicPilotPublish(join(parent, "source"), join(parent, "target"), {
      platform: "linux", helperPath: helper, execute
    })).rejects.toThrow(expected);
  });

  it("rejects NUL paths and an untrusted helper before process execution", async () => {
    const parent = temporaryDirectory("flowgate-atomic-publish-validation-");
    const helper = trustedFakeHelper(parent);
    const execute = vi.fn(async () => {});
    await expect(atomicPilotPublish(`${parent}\0/source`, join(parent, "target"), {
      platform: "linux", helperPath: helper, execute
    })).rejects.toThrow("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
    expect(execute).not.toHaveBeenCalled();

    chmodSync(helper, 0o600);
    await expect(atomicPilotPublish(join(parent, "source"), join(parent, "target"), {
      platform: "linux", helperPath: helper, execute
    })).rejects.toThrow("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a helper reached through a symlinked ancestor", async () => {
    const root = temporaryDirectory("flowgate-helper-symlink-root-");
    const actual = join(root, "actual");
    mkdirSync(actual, { mode: 0o700 });
    const helper = trustedFakeHelper(actual);
    const linked = join(root, "linked");
    symlinkSync(actual, linked);
    const execute = vi.fn(async () => {});

    await expect(atomicPilotPublish(join(root, "source"), join(root, "target"), {
      platform: "linux", helperPath: join(linked, "helper"), trustedRoot: root, execute
    } as any)).rejects.toThrow("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");

    expect(execute).not.toHaveBeenCalled();
    expect(readFileSync(helper, "utf8")).toBe("fake helper");
  });

  it("rejects an executable helper inside a group-writable ancestor", async () => {
    const root = temporaryDirectory("flowgate-helper-writable-root-");
    const writable = join(root, "writable");
    mkdirSync(writable, { mode: 0o770 });
    chmodSync(writable, 0o770);
    const helper = trustedFakeHelper(writable);
    const execute = vi.fn(async () => {});

    await expect(atomicPilotPublish(join(root, "source"), join(root, "target"), {
      platform: "linux", helperPath: helper, trustedRoot: root, execute
    } as any)).rejects.toThrow("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");

    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a helper path component reported as foreign-owned", async () => {
    const root = temporaryDirectory("flowgate-helper-foreign-root-");
    const native = join(root, "native");
    mkdirSync(native, { mode: 0o700 });
    const helper = trustedFakeHelper(native);
    const execute = vi.fn(async () => {});
    const inspectPath = (path: string) => {
      const stat = lstatSync(path);
      if (path !== native) return stat;
      return {
        ...stat, uid: stat.uid + 1,
        isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile(),
        isSymbolicLink: () => stat.isSymbolicLink()
      };
    };

    await expect(atomicPilotPublish(join(root, "source"), join(root, "target"), {
      platform: "linux", helperPath: helper, trustedRoot: root, inspectPath, execute
    } as any)).rejects.toThrow("PILOT_ATOMIC_PUBLISH_UNAVAILABLE");

    expect(execute).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "returns the fixed usage exit when the native helper receives invalid arguments",
    async () => {
      const helper = resolve(import.meta.dirname, "../dist/native/pilot-atomic-publish");
      const result = await execFileAsync(helper, []).then(
        () => 0,
        (error: any) => error.code
      );
      expect(result).toBe(64);
    }
  );
});

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function trustedFakeHelper(parent: string) {
  const helper = join(parent, "helper");
  writeFileSync(helper, "fake helper");
  chmodSync(helper, 0o700);
  return helper;
}
