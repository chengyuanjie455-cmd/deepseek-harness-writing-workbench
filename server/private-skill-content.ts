import {readFileSync,existsSync,readdirSync,lstatSync} from 'node:fs';import {join} from 'node:path';import {hash,type Doc} from './store.ts';
const marker='[内部技能原文已保留在主机私有存储；当前聊天、作品与任务记录继续保留。]';
/** Only known internal Skill text is redacted, never generic creative prompts or
 * ordinary user Skill files. Original host database records are not rewritten. */
export function privateSkillRedactor(codeRoot:string,dataRoot:string){
 const sources:string[]=[],seen=new Set<string>();
 const add=(file:string)=>{if(!existsSync(file)||!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())return;const body=readFileSync(file,'utf8'),digest=hash(body);if(!seen.has(digest)){seen.add(digest);sources.push(body);}};
 add(join(codeRoot,'video-skills/video-storyboard/SKILL.md'));add(join(codeRoot,'writing-skills/screenwriter/SKILL.md'));const snapshots=join(dataRoot,'private-skills');
 if(existsSync(snapshots)&&lstatSync(snapshots).isDirectory()&&!lstatSync(snapshots).isSymbolicLink()){
  for(const f of readdirSync(snapshots))if(/^[a-f0-9]{64}\.skill$/.test(f))add(join(snapshots,f));
  const legacy=join(snapshots,'legacy');if(existsSync(legacy)&&!lstatSync(legacy).isSymbolicLink())for(const dir of readdirSync(legacy)){add(join(legacy,dir,'video-storyboard/SKILL.md'));add(join(legacy,dir,'screenwriter/SKILL.md'));}
 }
 const chunks=[...new Set(sources.flatMap(s=>s.split('\n').map(l=>l.trim()).filter(l=>l.length>=48).flatMap(l=>Array.from({length:Math.floor((l.length-48)/16)+1},(_,n)=>l.slice(n*16,n*16+48)))))];
 const contains=(s:string)=>s.length>=48&&chunks.some(c=>s.includes(c));let redacted=0;
 const walk=(value:any):any=>{if(typeof value==='string'){
  // Keep ordinary text before/after a complete known private block, including
  // older mixed tool messages. Do not discard the surrounding story context.
  let safe=value;for(const source of sources)if(source)safe=safe.split(source).join(marker);
  safe=safe.replace(/[A-Za-z0-9+/=]{64,}/g,token=>contains(Buffer.from(token,'base64').toString('utf8'))?marker:token);
  if(contains(safe))safe=marker; // Partial/line-numbered copies remain private.
  if(safe!==value)redacted++;return safe;
 }if(Array.isArray(value))return value.map(walk);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v)]));return value;};
 return {redact<T>(value:T):{value:T;redactedStrings:number}{redacted=0;const safe=walk(value);return {value:safe,redactedStrings:redacted};},sourceDigests:[...seen]};
}
