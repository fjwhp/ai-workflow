import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildVerificationPlan } from "./verification-plan.js";

const roots:string[]=[];
afterEach(()=>Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))));

async function repo(){
  const root=await mkdtemp(join(tmpdir(),"verification-plan-"));roots.push(root);
  await writeFile(join(root,"pom.xml"),"<project/>");
  for(const module of ["dine-service/dine-admin-service","dine-service/dine-product-service"]){
    await mkdir(join(root,module,"src/main/java"),{recursive:true});
    await writeFile(join(root,module,"pom.xml"),"<project/>");
  }
  return root;
}

describe("verification plan",()=>{
  it("selects the nearest Maven module and deduplicates files",async()=>{
    const repoPath=await repo();
    const plan=await buildVerificationPlan({repoPath,changedFiles:["dine-service/dine-admin-service/pom.xml","dine-service/dine-admin-service/src/main/java/User.java"],fallbackCommands:[{command:"mvn",argsPrefix:["test","-pl","dine-service/dine-product-service"]}]});
    expect(plan).toEqual({changedModules:["dine-service/dine-admin-service"],plannedCommands:[{command:"mvn",argsPrefix:["test","-pl","dine-service/dine-admin-service","-am"]}],commandSource:"module_inference"});
  });

  it("creates one command per changed Maven module",async()=>{
    const repoPath=await repo();
    const plan=await buildVerificationPlan({repoPath,changedFiles:["dine-service/dine-admin-service/src/main/java/User.java","dine-service/dine-product-service/src/main/java/Product.java"],fallbackCommands:[]});
    expect(plan.changedModules).toEqual(["dine-service/dine-admin-service","dine-service/dine-product-service"]);
    expect(plan.plannedCommands).toHaveLength(2);
  });

  it("uses the safe project fallback for root build changes",async()=>{
    const repoPath=await repo(),fallbackCommands=[{command:"mvn",argsPrefix:["test"]}];
    expect(await buildVerificationPlan({repoPath,changedFiles:["pom.xml"],fallbackCommands})).toEqual({changedModules:["."],plannedCommands:fallbackCommands,commandSource:"project_fallback"});
  });

  it("returns no commands when neither inference nor fallback is available",async()=>{
    const repoPath=await repo();
    expect(await buildVerificationPlan({repoPath,changedFiles:["README.md"],fallbackCommands:[]})).toEqual({changedModules:[],plannedCommands:[],commandSource:"unavailable"});
  });
});
