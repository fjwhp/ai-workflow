import { afterEach,describe,expect,it } from "vitest";
import { execFile } from "node:child_process";import { mkdtemp,rm,writeFile } from "node:fs/promises";import { join } from "node:path";import { tmpdir } from "node:os";import { promisify } from "node:util";
import { WorkflowStore } from "./store.js";import { ensureProjectKnowledge,retrieveProjectKnowledge } from "./knowledge-service.js";
const exec=promisify(execFile),roots:string[]=[],stores:WorkflowStore[]=[];afterEach(async()=>{stores.splice(0).forEach(s=>s.close());await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})))});
describe("project knowledge lifecycle",()=>{it("reuses HEAD, refreshes after commits and retrieves relevant entries",async()=>{
  const repo=await mkdtemp(join(tmpdir(),"knowledge-service-"));roots.push(repo);await exec("git",["init","-b","main",repo]);await exec("git",["-C",repo,"config","user.email","t@e.com"]);await exec("git",["-C",repo,"config","user.name","T"]);await writeFile(join(repo,"README.md"),"订单平台\n");await writeFile(join(repo,"OrderController.java"),"create order 创建订单\n");await exec("git",["-C",repo,"add","--all"]);await exec("git",["-C",repo,"commit","-m","base"]);
  const store=new WorkflowStore(":memory:");stores.push(store);const project=store.createProject({name:"Repo",repoPath:repo,defaultBranch:"main",allowedCommands:[],sensitivePatterns:[]});
  const first=await ensureProjectKnowledge(store,project,"first_use"),same=await ensureProjectKnowledge(store,project,"ai_run");expect(same.id).toBe(first.id);
  await writeFile(join(repo,"UserController.java"),"class UserController { void createUser(){} }\n");await exec("git",["-C",repo,"add","--all"]);await exec("git",["-C",repo,"commit","-m","user"]);const refreshed=await ensureProjectKnowledge(store,project,"head_changed");expect(refreshed.version).toBe(2);
  const subset=retrieveProjectKnowledge(refreshed,{title:"新建系统用户",businessProblem:"运营需要创建用户",expectedOutcome:"支持建号"});expect(subset.entries.some((x:any)=>x.path.includes("UserController"))).toBe(true);
});});
