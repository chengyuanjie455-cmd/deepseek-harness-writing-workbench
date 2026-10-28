import {applyAssignment,assignmentSet} from './project-assignments';
// A read-only catalogue: never rename source files or invent episode links.
export type StudioSection='scripts'|'storyboards'|'assets'|'videos'|'edits'|'files';
export type AssetType='character'|'scene'|'prop'|'other';
export type StudioItem=Record<string,any>&{id:string;name:string;section:StudioSection;episodes:string[];assetType:AssetType};
type Row=Record<string,any>;
export const studioSections=[
 {id:'scripts',name:'剧本',icon:'script'}, {id:'storyboards',name:'分镜',icon:'board'},
 {id:'assets',name:'资产图',icon:'image'}, {id:'videos',name:'视频',icon:'video'}, {id:'edits',name:'剪辑',icon:'edit'},
] as const;
export const assetTypes=[{id:'all',name:'全部资产'},{id:'character',name:'人物 / 角色'},{id:'scene',name:'场景'},{id:'prop',name:'道具'},{id:'other',name:'待分类'}] as const;
const image=/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i,video=/\.(mp4|mov|m4v|webm|mkv)$/i;
import {episodeKey,episodeName} from './episodes';
export {episodeKey,episodeName};
export function assetType(value:unknown):AssetType {
 const s=String(value??'');
 if(/人物|角色|character|portrait/i.test(s))return 'character';
 if(/场景|场地|scene|environment/i.test(s))return 'scene';
 if(/道具|prop/i.test(s))return 'prop';
 return 'other';
}
export function projectSection(row:Row):StudioSection {
 const name=String(row.path??row.name??'');
 if(/剪辑|成片|拼接|精剪|粗剪|最终版|(?:^|[\/_ .-])(edit|edited|final|merged|montage)(?:[\/_ .-]|$)/i.test(name)||/\.(prproj|fcpxml|drp|mlt|otio|srt)$/i.test(name))return 'edits';
 if(/分镜|storyboard/i.test(name))return 'storyboards';
 if(row.kind==='image'||image.test(name)||String(row.mime??'').startsWith('image/'))return 'assets';
 if(row.kind==='video'||video.test(name)||String(row.mime??'').startsWith('video/'))return 'videos';
 if(/剧本|screenplay|(?:^|[\/_ .-])scripts?(?:[\/_ .-]|$)/i.test(name))return 'scripts';
 return 'files';
}
const basename=(s:string)=>s.split('/').at(-1)??s;
export function projectMediaURL(raw:unknown,project:string):string|undefined {
 if(typeof raw!=='string'||!raw.startsWith('/')||raw.startsWith('//'))return;
 const u=new URL(raw,'http://studio.local');
 if(!(/^\/api\/media\/[a-zA-Z0-9-]+(?:\/preview)?$/.test(u.pathname)||/^\/api\/native-attachments\/[a-f0-9]{64}\/content$/.test(u.pathname)||['/api/file-content','/api/gallery/attachment'].includes(u.pathname)))return;
 if(u.searchParams.has('project')&&u.searchParams.get('project')!==project)return;
 u.searchParams.set('project',project);return u.pathname+'?'+u.searchParams;
}
// A directly composed project page has a native credential, rather than the
// desktop connection's root cookie. Keep preview and playback in that scope.
export function studioMediaURL(raw:unknown,project:string,pathname:string):string|undefined {
 const value=projectMediaURL(raw,project);if(!value)return;
 const prefix=pathname.match(/^\/harness\/[^/]+(?=\/|$)/)?.[0];
 return (prefix?prefix+'/team-settings':'')+value;
}
export function initialStudioPage(search:string){return new URLSearchParams(search).has('project')?'native':'projects';}
export function studioGalleryPage<T>(items:readonly T[],requested=1){
 const size=48,pages=Math.max(1,Math.ceil(items.length/size)),page=Math.min(pages,Number.isSafeInteger(requested)&&requested>0?requested:1),start=(page-1)*size;
 return {items:items.slice(start,start+size),page,pages,total:items.length,from:items.length?start+1:0,to:Math.min(items.length,start+size)};
}
export function filterStudio(items:StudioItem[],section:StudioSection,episode='all',kind='all',query=''){
 const q=query.trim().toLocaleLowerCase();
 return items.filter(v=>(section==='files'||v.section===section)&&(episode==='all'||(episode==='unassigned'?!v.episodes.length:v.episodes.includes(episode)))&&(kind==='all'||v.assetType===kind)&&(!q||[v.name,v.path,v.sourceId,v.prompt,v.ownerName].filter(Boolean).join(' ').toLocaleLowerCase().includes(q)));
}
// The authorized project catalogue is available before a lazy media gallery is
// opened. Include those originals now, while keeping gallery aliases and source
// file identities as a single card. The caller supplies only the current
// project's matching revision; this function never fetches or widens access.
export function mergeStudioCatalogueDetails(values:StudioItem[],catalogue:StudioItem[]):StudioItem[]{
 const files=new Map(catalogue.filter(v=>v.id.startsWith('file:')).map(v=>[v.path,v]));
 const media=new Map(catalogue.filter(v=>v.mediaId).map(v=>[v.mediaId,v]));
 const attachments=catalogue.filter(v=>v.nativeAttachmentKey),aliases=new Map(attachments.filter(v=>v.galleryId).map(v=>[v.galleryId,v]));
 const enriched=values.map((v):StudioItem=>{
  const native=aliases.get(v.id);if(native)return {...v,...native};
  const detail=files.get(v.path)??media.get(v.mediaId);if(!detail)return v;
  return {...v,...detail,episodes:detail.episodes,sourceIds:Array.isArray(detail.sourceIds)?detail.sourceIds:v.sourceIds??[],section:detail.section??v.section,assetType:detail.assetType??v.assetType};
 });
 const ids=new Set(enriched.map(v=>v.id)),mediaIds=new Set(enriched.map(v=>v.mediaId).filter(Boolean));
 for(const item of catalogue){
  if(!item.mediaId&&!item.nativeAttachmentKey)continue;
  if(ids.has(item.id)||item.mediaId&&mediaIds.has(item.mediaId))continue;
  enriched.push(item);ids.add(item.id);if(item.mediaId)mediaIds.add(item.mediaId);
 }
 return enriched;
}
// Keep already loaded uploads while the native attachment index is refreshing.
// These fallback entries are name matches; indexed attachment bodies come from
// the authorized server result. Conversation message bodies are not indexed.
export function mergeStudioSearch(remote:StudioItem[],local:StudioItem[],section:StudioSection,episode:string,kind:string,query:string){
 const known=new Set(remote.flatMap(v=>[v.id,v.galleryId].filter(Boolean)));const uploads=filterStudio(local.filter(v=>v.id.startsWith('attachment:')&&!known.has(v.id)&&!known.has(v.galleryId)),section,episode,kind,query).map(v=>({...v,matchScope:'attachment-name'}));
 return [...new Map([...remote,...uploads].map(v=>[v.id,v])).values()];
}
export function studioDocumentKey(item:Row|undefined,project:string,revision?:string){
 if(!item)return;if(item.nativeAttachmentKey&&/^[a-f0-9]{64}$/.test(item.nativeAttachmentKey)&&item.project===project)return [project,'attachment',item.nativeAttachmentKey,item.versionId??item.sha256].join(':');
 if(item.path&&revision)return [project,'file',item.path,item.revision??revision].join(':');
}
export function studioDocumentRequest(item:Row,project:string,revision:string,offset=0){
 if(!studioDocumentKey(item,project,revision))return;
 if(item.nativeAttachmentKey)return '/native-attachments/'+item.nativeAttachmentKey+'/text?'+new URLSearchParams({project,offset:String(offset)});
 return '/file?'+new URLSearchParams({project,path:item.path,revision:item.revision??revision,offset:String(offset)});
}
export function buildStudioCatalogue(files:Row[],gallery:Row[]=[],plans:Row[]=[],index?:Row,projectName='项目'):StudioItem[]{
 const fileVersions=new Map(files.map(f=>[f.path,f.digest??f.sha256]));
 const links=new Map<string,{episodes:Set<string>;section?:StudioSection;type?:AssetType;title?:string;shots:Set<string>}>();
 const link=(key:unknown,ep:unknown,section?:StudioSection,type?:unknown,title?:unknown,shot?:unknown,digest?:string)=>{
  if(typeof key!=='string'||!key)return;
  if(digest&&fileVersions.has(key)&&fileVersions.get(key)!==digest)return;
  const v=links.get(key)??{episodes:new Set<string>(),shots:new Set<string>()};const e=episodeKey(ep);if(e)v.episodes.add(e);if(section)v.section=section;
  if(assetType(type)!=='other')v.type=assetType(type);if(typeof title==='string'&&title)v.title=title;if(typeof shot==='string')v.shots.add(shot);links.set(key,v);
 };
 const shots=[...(Array.isArray(index?.shots)?index.shots:[]),...plans.flatMap(p=>p.shots??[])];
 for(const row of shots){const s=row.source??row,e=s.episode??episodeKey(s.id);link(s.scriptPath,e,'scripts',undefined,undefined,s.id,s.scriptSHA256);link(s.storyboardPath,e,'storyboards',undefined,undefined,s.id,s.storyboardSHA256);for(const a of row.assets??s.assets??[]){for(const key of [a.path,a.file,a.mediaId,a.attachmentKey,a.id])link(key,e,'assets',a.kind??a.type??a.role,a.name,s.id,a.sha256);}for(const a of row.outputs??s.outputs??[]){for(const key of [a.path,a.mediaId,a.attachmentKey])link(key,e,undefined,undefined,a.name,s.id,a.sha256);}}
 const jobs=new Map<string,Row>();
 for(const p of plans)for(const j of p.jobs??[]){if(!j.mediaId)continue;const shot=(p.shots??[]).find((s:Row)=>s.source?.id===j.sourceId)??{};jobs.set(j.mediaId,{...j,shot,prompt:j.prompt??shot.prompt,assets:shot.assets??[],source:shot.source??{},plan:p});}
 let normalized:StudioItem[]=files.map(f=>{
  const l=links.get(f.path),episodes=[...(l?.episodes??[])];if(!episodes.length){const e=episodeKey(f.episode??f.path);if(e)episodes.push(e);}
  const section=l?.section??projectSection(f);
  return {...f,id:'file:'+f.path,name:basename(f.path),section,episodes,assetType:l?.type??assetType(f.assetType??f.path),kind:image.test(f.path)?'image':video.test(f.path)?'video':'document',source:'项目文件',sourceIds:[...(l?.shots??[])]};
 });
 const paths=new Set(files.map(f=>f.path));
 for(const g of gallery){if(g.path&&paths.has(g.path))continue;const job=jobs.get(g.mediaId),l=links.get(g.mediaId)??links.get(g.path),episodes=[...(l?.episodes??[])];
  if(!episodes.length){const e=episodeKey(job?.source?.episode??job?.sourceId??g.episode??g.path??g.name);if(e)episodes.push(e);}
  normalized.push({...g,id:g.id,name:g.name??g.id,section:l?.section??projectSection(g),episodes,assetType:l?.type??assetType(g.assetType??g.path??g.name),...(job?{prompt:job.prompt,assets:job.assets,sourceId:job.sourceId,scriptPath:job.source.scriptPath,storyboardPath:job.source.storyboardPath,round:job.round,state:job.state,jobId:job.id}:{}),sourceIds:[...(l?.shots??[])]});
 }
 const assigned=assignmentSet(index?.contentAssignments).items;normalized=normalized.map(v=>applyAssignment(v,assigned) as StudioItem);
 // Stable display names are shared across views; source paths/IDs remain intact.
 for(const v of normalized){const stage=studioSections.find(s=>s.id===v.section)?.name??'资料',ep=v.episodes.length===1?v.episodes[0]:v.episodes.length>1?'多集关联':'公共',role=v.section==='assets'?assetTypes.find(a=>a.id===v.assetType)?.name:undefined;
  v.displayName=[ep,v.sourceId,role??stage,v.name].filter(Boolean).join(' · ');v.projectName=projectName;}
 return normalized;
}
