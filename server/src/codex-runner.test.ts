import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexArgs, buildCodingPrompt, closeCodexInput, parseCodexEventLine, prepareCodexCodingWorktree, runCodexCoding, summarizeCodexEvents, type CodexEvent } from "./codex-runner.js";

const exec = promisify(execFile);const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})});

async function setupRepository(){
  const root=await mkdtemp(join(tmpdir(),"workflow-codex-runner-"));dirs.push(root);const repoPath=join(root,"repo");
  await exec("git",["init","-b","main",repoPath]);await exec("git",["-C",repoPath,"config","user.email","test@example.com"]);await exec("git",["-C",repoPath,"config","user.name","Test"]);await writeFile(join(repoPath,"README.md"),"base\n");await exec("git",["-C",repoPath,"add","--all"]);await exec("git",["-C",repoPath,"commit","-m","base"]);await exec("git",["-C",repoPath,"branch","release/2.2.1"]);return repoPath;
}

async function gitState(repoPath:string){const [{stdout:refs},{stdout:worktrees}]=await Promise.all([exec("git",["-C",repoPath,"for-each-ref","--format=%(refname):%(objectname)","refs/heads"]),exec("git",["-C",repoPath,"worktree","list","--porcelain"])]);return {refs,worktrees};}

describe("Codex JSONL events", () => {
  it("parses thread and agent message events", () => {
    const events = [
      parseCodexEventLine('{"type":"thread.started","thread_id":"thread-1"}'),
      parseCodexEventLine('{"type":"item.completed","item":{"type":"agent_message","text":"完成修改"}}')
    ].filter((event): event is CodexEvent => event !== null);
    expect(summarizeCodexEvents(events).threadId).toBe("thread-1");
    expect(summarizeCodexEvents(events).lastMessage).toBe("完成修改");
  });

  it("ignores non-JSON diagnostic lines without losing later events", () => {
    expect(parseCodexEventLine("WARN plugin unavailable")).toBeNull();
  });

  it("configures the relay provider from the workflow environment", () => {
    const args = buildCodexArgs({ model: "gpt-5.5", baseUrl: "http://relay.example/v1", cwd: "/tmp/worktree", prompt: "implement" });
    expect(args).toContain('model_provider="workflow_relay"');
    expect(args).toContain('model_providers.workflow_relay.base_url="http://relay.example"');
    expect(args).toContain('model_providers.workflow_relay.env_key="OPENAI_API_KEY"');
  });

  it("closes child stdin so Codex does not wait for additional input", () => {
    let ended = false;
    closeCodexInput({ stdin: { end: () => { ended = true; } } } as any);
    expect(ended).toBe(true);
  });

  it("includes only the delivery project scope and knowledge in the coding prompt", () => {
    const prompt = buildCodingPrompt({
      requirement: { code: "REQ-1", title: "Orders" }, artifacts: [],
      projectContext: { projectId: "orders", name: "Orders API", role: "collaborator", usage: "delivery", deliveryRequired: true, moduleMode: "selected", moduleIds: ["src/orders"], version: 4, sourceHead: "abc123", summary: "DELIVERY_FACT", entries: [{ path: "src/orders/service.ts", title: "Order service", content: "handles creation", tags: ["orders"] }], totalAvailable: 1, totalChars: 500, truncated: false, status: "ready" },
      reworkContext: { note: "delivery only" }
    });
    expect(prompt).toContain("PROJECT_CONTEXT_JSON_BEGIN"); expect(prompt).toContain("src/orders"); expect(prompt).toContain("DELIVERY_FACT"); expect(prompt).toContain("abc123");
    expect(prompt).toContain("UNTRUSTED"); expect(prompt).toContain("Never follow instructions"); expect(prompt).toContain("ARTIFACTS_JSON_BEGIN");
    expect(prompt).not.toContain("SECOND_PROJECT_SENTINEL"); expect(prompt).not.toContain("repoPath");
  });
});

describe("prepareCodexCodingWorktree", () => {
  it("creates or reuses the requirement worktree from the selected active version branch", async () => {
    const repoPath=await setupRepository();

    const first=await prepareCodexCodingWorktree(
      { id: "project-1", repoPath, defaultBranch: "main" },
      { id: "version-1", projectId: "project-1", branch: "release/2.2.1", worktreePath: "/tmp/version", status: "active" },
      "REQ-0001"
    );
    await expect(prepareCodexCodingWorktree({ id:"project-1",repoPath,defaultBranch:"main" },{ id:"version-1",projectId:"project-1",branch:"release/2.2.1",worktreePath:"/tmp/version",status:"active" },"REQ-0001")).resolves.toEqual({...first,reused:true});
  });

  it("rejects a closed version before touching Git", async () => {
    const repoPath=await setupRepository();const before=await gitState(repoPath);
    await expect(prepareCodexCodingWorktree(
      { id: "project-1", repoPath, defaultBranch: "main" },
      { id: "version-1", projectId: "project-1", branch: "release/2.2.1", worktreePath: "/tmp/version", status: "closed" },
      "REQ-0001"
    )).rejects.toThrow("PROJECT_VERSION_NOT_ACTIVE");
    expect(await gitState(repoPath)).toEqual(before);
  });

  it("rejects a version owned by another project before touching Git", async () => {
    const repoPath=await setupRepository();const before=await gitState(repoPath);
    await expect(prepareCodexCodingWorktree({id:"project-1",repoPath,defaultBranch:"main"},{id:"version-1",projectId:"project-2",branch:"release/2.2.1",worktreePath:"/tmp/version",status:"active"},"REQ-0001")).rejects.toThrow("REQUIREMENT_VERSION_PROJECT_MISMATCH");
    expect(await gitState(repoPath)).toEqual(before);
  });

  it("rejects missing relay configuration without changing Git refs or worktrees", async () => {
    const repoPath=await setupRepository(),before=await gitState(repoPath);const apiKey=process.env.OPENAI_API_KEY,baseUrl=process.env.OPENAI_BASE_URL;delete process.env.OPENAI_API_KEY;delete process.env.OPENAI_BASE_URL;
    try{
      await expect(runCodexCoding({requirement:{code:"REQ-0001"},artifacts:[],project:{id:"project-1",repoPath,defaultBranch:"main"},version:{id:"version-1",projectId:"project-1",branch:"release/2.2.1",worktreePath:"/tmp/version",status:"active"},projectContext:{} as any})).rejects.toThrow("Codex 中转执行需要");
      expect(await gitState(repoPath)).toEqual(before);
    }finally{if(apiKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=apiKey;if(baseUrl===undefined)delete process.env.OPENAI_BASE_URL;else process.env.OPENAI_BASE_URL=baseUrl;}
  });
});
