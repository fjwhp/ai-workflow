import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getLocalBranches, getWorktreeSnapshot, isProtectedBranch } from "./repository.js";

const exec = promisify(execFile); const dirs: string[] = [];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})});

describe("getWorktreeSnapshot",()=>{
  it("includes files nested inside an untracked directory",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"workflow-git-"));dirs.push(dir);
    await exec("git",["init",dir]);
    await mkdir(join(dir,"src","test"),{recursive:true});
    await writeFile(join(dir,"src","test","new.txt"),"hello\n");
    const snapshot=await getWorktreeSnapshot(dir);
    expect(snapshot.files).toContain("src/test/new.txt");
    expect(snapshot.diff).toContain("+hello");
  });
});

describe("local integration branches",()=>{
  it("lists local branches and marks the current and protected branches",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"workflow-branches-"));dirs.push(dir);
    await exec("git",["init","-b","main",dir]);
    await exec("git",["-C",dir,"config","user.email","test@example.com"]);await exec("git",["-C",dir,"config","user.name","Test"]);
    await writeFile(join(dir,"README.md"),"base\n");await exec("git",["-C",dir,"add","--all"]);await exec("git",["-C",dir,"commit","-m","base"]);
    await exec("git",["-C",dir,"branch","feature/0710-test"]);await exec("git",["-C",dir,"switch","feature/0710-test"]);
    const result=await getLocalBranches(dir);
    expect(result.currentBranch).toBe("feature/0710-test");
    expect(result.branches).toEqual([
      {name:"feature/0710-test",current:true,protected:false},
      {name:"main",current:false,protected:true}
    ]);
    expect(isProtectedBranch("prod")).toBe(true);expect(isProtectedBranch("feature/prod-fix")).toBe(false);
  });
});
