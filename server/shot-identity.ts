import {hash,type Doc} from './store.ts';
const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
export const validShotIdentity=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x1f\x7f]/.test(value);
// Preserve the identity already used by legacy read projections. A subsequent
// authorized edit can persist it without rewriting any historical index.
export function shotEntityId(project:string,row:Doc){return validShotIdentity(row.entityId)?row.entityId:'shot:'+hash(JSON.stringify([project,row.id]));}
export function shotView(project:string,row:Doc):Doc{
 const entityId=shotEntityId(project,row),{entityId:_,versionId:__,...content}=row;
 return {...row,entityId,versionId:hash(JSON.stringify([entityId,stable(content)]))};
}
export function duplicateShotIdentities(project:string,rows:Doc[]){const definitions=new Map<string,Set<string>>();for(const row of rows)if(row&&typeof row==='object'){const key=shotEntityId(project,row),versions=definitions.get(key)??new Set<string>();versions.add(shotView(project,row).versionId);definitions.set(key,versions);}return new Set([...definitions].filter(([,versions])=>versions.size>1).map(([key])=>key));}
export const shotRelationship=(project:string,row:Doc)=>({kind:'shot',sourceId:row.id,entityId:shotEntityId(project,row),versionId:typeof row.versionId==='string'&&/^[a-f0-9]{64}$/.test(row.versionId)?row.versionId:shotView(project,row).versionId});
