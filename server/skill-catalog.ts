import {existsSync,readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {hash,now,requireThat,type Doc,Store} from './store.ts';

export type SkillDescriptor={id:string;name:string;description:string;version:string;kind:'screenwriter'|'video-storyboard';status:'published'|'disabled';memberAccess:boolean;sha256:string;provenance?:string};
type Builtin={id:'screenwriter'|'video-storyboard';name:string;description:string;kind:'screenwriter'|'video-storyboard';file:string;provenance?:string};
const BUILTINS:ReadonlyArray<Builtin>=[
 {id:'screenwriter',name:'编剧工作台',description:'整理剧本、人物、场次、对白与连续性，输出可审核候选稿。',kind:'screenwriter',file:'writing-skills/screenwriter/SKILL.md',provenance:'writing-method-suite@1.3'},
 {id:'video-storyboard',name:'视频分镜',description:'为视频补抽整理镜头提示词和参考素材。',kind:'video-storyboard',file:'video-skills/video-storyboard/SKILL.md'}
] as const;

/** Host-owned skill catalog. Public projections contain only published metadata;
 * source text is loaded by the host executor and never sent to members. */
export class SkillCatalog {
 private file:string;
 constructor(private store:Store){this.file=join(store.root,'skill-policy.json');if(existsSync(this.file)){chmodSync(this.file,0o600);}}
 private body(row:Builtin){const body=readFileSync(new URL('../'+row.file,import.meta.url),'utf8');return {body,sha256:hash(body),version:(body.match(/version:\s*["']([^"']+)/)?.[1]??(row.id==='screenwriter'?'2026.10.27.1':'2026.09.27.3'))};}
 metadata(id:string):SkillDescriptor{const row=BUILTINS.find(v=>v.id===id);requireThat(row,'技能不存在',404);const source=this.body(row);const p=this.policy('shared');const status=p.skillIds.includes(id)?'published':'disabled';return {id:row.id,name:row.name,description:row.description,kind:row.kind,version:source.version,status,memberAccess:status==='published',sha256:source.sha256,...(row.provenance?{provenance:row.provenance}: {})};}
 source(id:string){const row=BUILTINS.find(v=>v.id===id);requireThat(row,'技能不存在',404);return {body:this.body(row).body,metadata:this.metadata(id)};}
 all(){return BUILTINS.map(v=>this.metadata(v.id));}
 policy(project:string):Doc{const saved=this.store.get('skill-policy',project);const ids=Array.isArray(saved?.skillIds)?saved.skillIds.filter((id:string)=>BUILTINS.some(v=>v.id===id)):[...BUILTINS.map(v=>v.id)];const savedDefault=typeof saved?.defaultSkillId==='string'?saved.defaultSkillId:undefined;const defaultSkillId=savedDefault&&ids.includes(savedDefault)?savedDefault:ids.includes('screenwriter')?'screenwriter':ids[0];return {id:project,skillIds:ids,defaultSkillId};}
 public(user:Doc,project:string){const p=this.policy(project);return this.all().filter(v=>v.status==='published'&&v.memberAccess&&p.skillIds.includes(v.id)).map(({sha256,provenance,...v})=>v);}
 select(user:Doc,project:string,requested?:string){const p=this.policy(project),id=requested??p.defaultSkillId,meta=this.metadata(id);requireThat(meta.status==='published'&&meta.memberAccess&&p.skillIds.includes(id),'技能未发布或未向当前项目开放',403);return meta;}
 savePolicy(actor:Doc,project:string,b:Doc){requireThat(actor.role==='admin','仅超级管理员可管理技能',403);requireThat(Array.isArray(b.skillIds)&&b.skillIds.length>0&&b.skillIds.every((id:string)=>BUILTINS.some(v=>v.id===id)),'技能范围无效');requireThat(typeof b.defaultSkillId==='string'&&b.skillIds.includes(b.defaultSkillId),'默认技能必须在开放范围内');const policy={id:project,skillIds:[...new Set(b.skillIds)],defaultSkillId:b.defaultSkillId,updated:now()};let all:Doc={};try{all=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{};}catch{}all[project]=policy;const tmp=this.file+'.tmp';writeFileSync(tmp,JSON.stringify(all),{mode:0o600});renameSync(tmp,this.file);this.store.put('skill-policy',policy);this.store.audit(actor.id,'skill.policy.publish',project,{skillIds:policy.skillIds,defaultSkillId:policy.defaultSkillId});return {policy,skills:this.all()};}
}
