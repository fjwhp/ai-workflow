import { execFile } from "node:child_process";
import {
  chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("pilot native helper build", () => {
  it("repairs an owned group-writable output directory before publishing", async () => {
    const fixture = buildFixture("flowgate-helper-build-writable-");
    mkdirSync(fixture.outputDir, { recursive: true });
    chmodSync(fixture.outputDir, 0o770);

    await runBuild(fixture);

    expect(lstatSync(fixture.outputDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(fixture.outputDir, "pilot-atomic-publish")).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlinked output directory without writing through it", async () => {
    const fixture = buildFixture("flowgate-helper-build-symlink-");
    const outside = join(fixture.root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    mkdirSync(resolve(fixture.outputDir, ".."), { recursive: true });
    symlinkSync(outside, fixture.outputDir);

    await expect(runBuild(fixture)).rejects.toBeDefined();

    expect(readdirSync(outside)).toEqual([]);
  });

  it("preserves the last trusted helper when a new compilation fails", async () => {
    const fixture = buildFixture("flowgate-helper-build-failure-", false);
    mkdirSync(fixture.outputDir, { recursive: true, mode: 0o700 });
    const output = join(fixture.outputDir, "pilot-atomic-publish");
    writeFileSync(output, "trusted-old-helper");
    chmodSync(output, 0o700);

    await runBuild(fixture);

    expect(readFileSync(output, "utf8")).toBe("trusted-old-helper");
    expect(readdirSync(fixture.outputDir).sort()).toEqual([
      "install-pilot-atomic-publish.mjs", "pilot-atomic-publish", "pilot-atomic-publish.c"
    ]);
  });
});

function buildFixture(prefix: string, compilerSucceeds = true) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  directories.push(root);
  const serverRoot = join(root, "server");
  mkdirSync(join(serverRoot, "scripts"), { recursive: true });
  mkdirSync(join(serverRoot, "native"), { recursive: true });
  cpSync(resolve(import.meta.dirname, "../scripts/build-pilot-atomic-publish.mjs"),
    join(serverRoot, "scripts/build-pilot-atomic-publish.mjs"));
  cpSync(resolve(import.meta.dirname, "../native/pilot-atomic-publish.c"),
    join(serverRoot, "native/pilot-atomic-publish.c"));
  cpSync(resolve(import.meta.dirname, "../native/install-pilot-atomic-publish.mjs"),
    join(serverRoot, "native/install-pilot-atomic-publish.mjs"));
  const bin = join(root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const compiler = join(bin, "cc");
  writeFileSync(compiler, compilerSucceeds ? `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift
done
printf 'new-helper' > "$out"
` : "#!/bin/sh\nexit 1\n");
  chmodSync(compiler, 0o700);
  return {
    root, serverRoot, outputDir: join(serverRoot, "dist/native"),
    script: join(serverRoot, "scripts/build-pilot-atomic-publish.mjs"), bin
  };
}

function runBuild(fixture: ReturnType<typeof buildFixture>) {
  return execFileAsync(process.execPath, [fixture.script], {
    env: { ...process.env, PATH: `${fixture.bin}:/usr/bin:/bin` }
  });
}
