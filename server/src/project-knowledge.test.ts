import { afterEach,describe,expect,it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp,rm,writeFile,mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { buildProjectKnowledge } from "./project-knowledge.js";
const exec=promisify(execFile),roots:string[]=[];
afterEach(()=>Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))));

describe("buildProjectKnowledge",()=>{
  it("indexes useful tracked files and excludes secrets",async()=>{
    const repo=await mkdtemp(join(tmpdir(),"knowledge-"));roots.push(repo);
    await exec("git",["init","-b","main",repo]);await exec("git",["-C",repo,"config","user.email","t@e.com"]);await exec("git",["-C",repo,"config","user.name","T"]);
    await mkdir(join(repo,"src"));await mkdir(join(repo,"modules"));await writeFile(join(repo,"README.md"),"点餐平台订单与用户管理\n");await writeFile(join(repo,"src","OrderController.java"),"class OrderController { void createOrder(){} }\n");for(let i=0;i<45;i++)await writeFile(join(repo,"modules",`${String(i).padStart(2,"0")}.xml`),"x".repeat(4000));await writeFile(join(repo,".env"),"OPENAI_API_KEY=secret\n");await writeFile(join(repo,"private.pem"),"SECRET\n");
    await exec("git",["-C",repo,"add","--all"]);await exec("git",["-C",repo,"commit","-m","base"]);
    const result=await buildProjectKnowledge({repoPath:repo,sensitivePatterns:["private*"]});
    expect(result.sourceHead).toMatch(/^[0-9a-f]{40}$/);expect(result.entries.map(x=>x.path)).toContain("README.md");expect(result.entries.map(x=>x.path)).toContain("src/OrderController.java");
    expect(JSON.stringify(result)).not.toContain("OPENAI_API_KEY");expect(result.entries.map(x=>x.path)).not.toContain("private.pem");expect(result.totalChars).toBeLessThanOrEqual(300000);
    expect((await exec("git",["-C",repo,"status","--porcelain"])).stdout).toBe("");
  });
});
