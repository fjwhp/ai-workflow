import { access } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export type VerificationCommand={command:string;argsPrefix:string[]};
export type VerificationPlan={changedModules:string[];plannedCommands:VerificationCommand[];commandSource:"module_inference"|"project_fallback"|"unavailable"};

const safeExecutables=new Set(["mvn","mvnw","./mvnw","npm","gradle","./gradlew"]);

function safeFallback(commands:VerificationCommand[]){
  return commands.filter(item=>safeExecutables.has(item.command)&&item.argsPrefix.every(arg=>!/[;&|`$<>\n\r]/.test(arg)));
}

async function exists(path:string){try{await access(path);return true}catch{return false}}

async function nearestMavenModule(repoPath:string,file:string){
  const root=resolve(repoPath),target=resolve(root,file),rel=relative(root,target);
  if(rel.startsWith(`..${sep}`)||rel==="..")return null;
  let current=dirname(target);
  while(current!==root){
    if(await exists(resolve(current,"pom.xml")))return relative(root,current).split(sep).join("/");
    const parent=dirname(current);if(parent===current)break;current=parent;
  }
  return null;
}

export async function buildVerificationPlan(input:{repoPath:string;changedFiles:string[];fallbackCommands:VerificationCommand[]}):Promise<VerificationPlan>{
  const fallback=safeFallback(input.fallbackCommands||[]);
  const rootBuildChanged=input.changedFiles.some(file=>file==="pom.xml"||file==="package.json"||file==="settings.gradle"||file==="settings.gradle.kts");
  if(rootBuildChanged)return {changedModules:["."],plannedCommands:fallback,commandSource:fallback.length?"project_fallback":"unavailable"};
  const modules=(await Promise.all(input.changedFiles.map(file=>nearestMavenModule(input.repoPath,file)))).filter((value):value is string=>Boolean(value));
  const changedModules=[...new Set(modules)].sort();
  if(changedModules.length)return {changedModules,plannedCommands:changedModules.map(module=>({command:"mvn",argsPrefix:["test","-pl",module,"-am"]})),commandSource:"module_inference"};
  return {changedModules:[],plannedCommands:fallback,commandSource:fallback.length?"project_fallback":"unavailable"};
}
