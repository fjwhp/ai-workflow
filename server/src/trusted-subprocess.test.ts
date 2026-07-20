import { describe, expect, it } from "vitest";
import { runTrustedSubprocess } from "./trusted-subprocess.js";

describe("runTrustedSubprocess", () => {
  it("runs fixed argv without a shell and captures bounded output", async () => {
    const result = await runTrustedSubprocess(process.execPath, [
      "-e", "process.stdout.write(process.argv[1])", "literal;$HOME"
    ], { timeoutMs: 1_000, termGraceMs: 50, maxOutputBytes: 1024 });

    expect(result).toEqual({ exitCode: 0, stdout: "literal;$HOME", stderr: "", timedOut: false, outputOverflow: false });
  });

  it("escalates a deadline from TERM to KILL and returns within the fixed budget", async () => {
    const started = Date.now();
    const result = await runTrustedSubprocess(process.execPath, [
      "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
    ], { timeoutMs: 30, termGraceMs: 30, maxOutputBytes: 1024 });

    expect(result).toMatchObject({ exitCode: -1, timedOut: true, outputOverflow: false });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("kills a child whose combined output exceeds the cap", async () => {
    const result = await runTrustedSubprocess(process.execPath, [
      "-e", "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"
    ], { timeoutMs: 1_000, termGraceMs: 30, maxOutputBytes: 64 });

    expect(result).toMatchObject({ exitCode: -1, timedOut: false, outputOverflow: true });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64);
  });
});
