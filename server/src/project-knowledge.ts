import { execFile } from "node:child_process";
import { readFile,stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
const exec=promisify(execFile);
const allowed=/\.(md|txt|json|ya?ml|xml|sql|java|kt|ts|tsx|js|jsx|py|go|rs|properties|gradle)$/i;
const excluded=/(^|\/)(\.git|node_modules|target|dist|build|coverage|\.idea)(\/|$)|(^|\/)\.env($|\.)|\.(pem|key|p12|pfx|jks|keystore|crt)$/i;
export type KnowledgeEntry={path:string;kind:"overview"|"module"|"api"|"domain"|"schema"|"rule"|"test"|"constraint";title:string;content:string;tags:string[]};
export async function getRepositoryHead(repoPath:string){return (await exec("git",["-C",repoPath,"rev-parse","HEAD"])).stdout.trim();}

function globMatch(path:string,pattern:string){const escaped=pattern.replace(/[.+^${}()|[\]\\]/g,"\\$&").replaceAll("*",".*").replaceAll("?",".");return new RegExp(`^${escaped}$`,"i").test(path)||new RegExp(`(^|/)${escaped}$`,"i").test(path);}
function kind(path:string):KnowledgeEntry["kind"]{if(/readme/i.test(path))return "overview";if(/pom\.xml|package\.json|build\.gradle/i.test(path))return "module";if(/controller|route|\/[^/]*Api\.(java|kt|ts)$/i.test(path))return "api";if(/migration|schema|\.sql$/i.test(path))return "schema";if(/test|spec/i.test(path))return "test";if(/entity|model|domain/i.test(path))return "domain";if(/service|validator|rule/i.test(path))return "rule";return "constraint";}
const priorities:Record<KnowledgeEntry["kind"],number>={overview:100,api:95,module:92,schema:90,domain:85,rule:80,test:75,constraint:10};
export async function buildProjectKnowledge(input:{repoPath:string;sensitivePatterns:string[]}){
  const sourceHead=await getRepositoryHead(input.repoPath);
  const files=(await exec("git",["-C",input.repoPath,"ls-files"])).stdout.split("\n").filter(Boolean);
  const entries:KnowledgeEntry[]=[];let totalChars=0,truncated=false;
  const ranked=files.filter(path=>allowed.test(path)&&!excluded.test(path)&&!input.sensitivePatterns.some(pattern=>globMatch(path,pattern))).sort((a,b)=>priorities[kind(b)]-priorities[kind(a)]||a.localeCompare(b));
  for(const path of ranked){if(entries.length>=200||totalChars>=300000){truncated=true;break}const full=resolve(input.repoPath,path);const info=await stat(full);if(!info.isFile()||info.size>131072)continue;let content:string;try{content=await readFile(full,"utf8")}catch{continue}if(content.includes("\0"))continue;const room=300000-totalChars,excerpt=content.slice(0,Math.min(room,2000));if(!excerpt)continue;entries.push({path,kind:kind(path),title:path.split("/").at(-1)||path,content:excerpt,tags:path.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean)});totalChars+=excerpt.length;if(excerpt.length<content.length)truncated=true;}
  const overview=entries.find(entry=>entry.kind==="overview");
  return {sourceHead,summary:(overview?.content||entries.slice(0,3).map(x=>x.title).join("、")).slice(0,2000),entries,totalChars,truncated};
}
