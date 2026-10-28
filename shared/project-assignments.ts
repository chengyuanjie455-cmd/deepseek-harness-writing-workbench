// Optional, version-specific display classification. Originals and actual shot /
// generation provenance remain independent and are never rewritten by this view.
type Row=Record<string,any>;
import {episodeKey as episode} from './episodes';
const sections=new Set(['scripts','storyboards','assets','videos','edits','files']),types=new Set(['character','scene','prop','other']);
const fileId=(value:unknown)=>typeof value==='string'?value.replace(/^file:/,''):undefined;
export function assignmentRefKey(ref:Row){return ref.entityId?'entity:'+fileId(ref.entityId):ref.path?'path:'+ref.path:ref.mediaId?'media:'+ref.mediaId:ref.attachmentKey?'attachment:'+ref.attachmentKey:undefined;}
export function assignmentMatches(assignment:Row,item:Row){const ref=assignment.reference;if(!ref||ref.sha256!==(item.sha256??item.digest))return false;
 if(ref.mediaId)return ref.mediaId===item.mediaId;
 if(ref.attachmentKey)return ref.attachmentKey===item.nativeAttachmentKey;
 if(ref.entityId&&item.entityId)return fileId(ref.entityId)===fileId(item.entityId);
 return !!ref.path&&ref.path===item.path;
}
export function assignmentSet(value:unknown):{items:Row[];warnings:string[]}{
 if(value===undefined)return {items:[],warnings:[]};if(!Array.isArray(value))return {items:[],warnings:['资料归类记录暂不可读取，未据此修改分类或猜测集数。']};
 const rows:Row[]=[],warnings:string[]=[];for(const raw of value){if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.id!=='string'||!raw.id||!raw.reference||typeof raw.reference!=='object'||Array.isArray(raw.reference)||!assignmentRefKey(raw.reference)||!/^[a-f0-9]{64}$/.test(raw.reference.sha256)||raw.episodes!==undefined&&(!Array.isArray(raw.episodes)||raw.episodes.some((v:unknown)=>!episode(v)))||raw.section!==undefined&&!sections.has(raw.section)||raw.assetType!==undefined&&!types.has(raw.assetType)){warnings.push('有不完整的资料归类记录，原件保留，未据此猜测关联。');continue;}rows.push({...raw,...(raw.episodes!==undefined?{episodes:[...new Set(raw.episodes.map(episode))]}:{})});}
 const signatures=new Map<string,Set<string>>(),identity=(r:Row)=>assignmentRefKey(r.reference)+':'+r.reference.sha256;
 for(const r of rows)for(const key of ['id:'+r.id,'target:'+identity(r)]){const signature=JSON.stringify([identity(r),r.episodes,r.section,r.assetType]);signatures.set(key,new Set([...(signatures.get(key)??[]),signature]));}
 const conflicts=new Set([...signatures].filter(([,v])=>v.size>1).map(([k])=>k));if(conflicts.size)warnings.push('同一资料版本的归类记录相互冲突，未选择其中一份覆盖。');const seen=new Set<string>();return {items:rows.filter(r=>{const key=identity(r);if(conflicts.has('id:'+r.id)||conflicts.has('target:'+key)||seen.has(key))return false;seen.add(key);return true;}),warnings:[...new Set(warnings)]};
}
export function applyAssignment(item:Row,assignments:Row[]):Row{
 const matches=assignments.filter(a=>assignmentMatches(a,item));if(matches.length!==1)return item;const a=matches[0],result:Row={...item,...(a.episodes===undefined?{}:{episodes:a.episodes}),...(a.section===undefined?{}:{section:a.section}),...(a.assetType===undefined?{}:{assetType:a.assetType}),assignmentId:a.id,assignmentReference:a.reference,episodeEvidence:a.episodes===undefined?item.episodeEvidence:'explicit',classificationEvidence:'explicit'};if(item.sourceType==='native_attachment'&&a.episodes!==undefined)result.displayName=[a.episodes.join(' / ')||'公共',item.ownerName,item.name].filter(Boolean).join(' · ');return result;
}
