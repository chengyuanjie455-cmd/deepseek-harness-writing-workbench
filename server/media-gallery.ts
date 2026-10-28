import {generationLinks,nativeSessionFor} from './generation-links.ts';
import {existsSync} from 'node:fs';
import {join,basename} from 'node:path';
import {hash,requireThat,type Doc} from './store.ts';
import type {Platform} from './app.ts';
const kindOf=(name:string,mime='')=>mime.startsWith('image/')||/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(name)?'image':mime.startsWith('video/')||/\.(mp4|mov|m4v|webm|mkv)$/i.test(name)?'video':undefined;
/** Catalogue only: original files stay in their existing authenticated storage. */
export async function mediaGallery(app:Platform,user:Doc,params:URLSearchParams,options:{all?:boolean}={}){
 const project=params.get('project')??'shared',ws=app.workspace(project),session=params.get('session')||undefined,owner=params.get('owner')||(session?user.id:undefined),kind=params.get('kind')??'image',q=(params.get('q')??'').trim().toLowerCase();
 if(session)requireThat(/^session-[a-zA-Z0-9-]{1,160}$/.test(session),'聊天编号无效');
 requireThat(['image','video','all'].includes(kind),'媒体类型无效');requireThat(!owner||user.role==='admin'||owner===user.id,'不能查看其他成员的私有媒体',403);
 const owners=app.store.all('user').filter(u=>owner?u.id===owner:user.role==='admin'||u.id===user.id);requireThat(!owner||owners.length===1,'成员不存在',404);
 const visible=new Set(owners.map(u=>u.id)),items:Doc[]=[],warnings:string[]=[],paths=new Set<string>();const revision=ws.projects.current().revision,jobs=new Map([...(kind!=='video'?ws.store.all('image-job'):[]),...(kind!=='image'?ws.store.all('video-job'):[]),...(kind!=='image'?ws.store.all('assembly-job'):[])].filter(j=>j.mediaId).map(j=>[j.mediaId,j]));
 const sessionMedia=new Set<string>();for(const j of ws.store.all('assembly-job'))if(j.owner===owner&&j.nativeSession===session&&j.state==='ready'&&j.mediaId)sessionMedia.add(j.mediaId);
 if(session){const links=generationLinks(ws.store),plans=new Set(links.plans.filter(p=>p.owner===owner&&(p.project??'shared')===project&&nativeSessionFor(ws.store,p)===session).map(p=>p.id));for(const a of links.audits)if(a.owner===owner&&a.project===project&&a.session===session)plans.add(a.planId);for(const j of links.jobs)if(j.owner===owner&&(j.project??'shared')===project&&plans.has(j.plan??j.planId??j.pickup)&&j.mediaId)sessionMedia.add(j.mediaId);for(const p of links.plans.filter(p=>plans.has(p.id)))for(const shot of p.shots??[p])for(const a of shot.assets??[])if(a.mediaId)sessionMedia.add(a.mediaId);}
 const qaFrames=new Set(ws.store.all('media-check').flatMap(c=>(c.result?.frames??[]).map((f:Doc)=>f.mediaId))),creativeRefs=new Set([...ws.store.all('pickup'),...ws.store.all('image-plan')].flatMap(p=>(p.shots??[p]).flatMap((s:Doc)=>(s.assets??[]).filter((a:Doc)=>a.mediaId).map((a:Doc)=>JSON.stringify([p.owner,a.mediaId])))));
 for(const m of ws.store.all('media')){
  if((m.internalDerived==='video_qa_frame'||qaFrames.has(m.id))&&!creativeRefs.has(JSON.stringify([m.owner,m.id])))continue;
  const mediaKind=kindOf(m.name??'',m.mime);if(!mediaKind||!(m.scope==='project'||visible.has(m.owner))||kind!=='all'&&mediaKind!==kind||session&&!sessionMedia.has(m.id))continue;
  if(m.attachmentPath&&ws.projects.revision(revision).manifest[m.attachmentPath]!==m.sha256)continue;
  if(m.attachmentPath)paths.add(m.attachmentPath);
  const job=jobs.get(m.id),url='/api/media/'+m.id;
  items.push({id:'media:'+m.id,mediaId:m.id,kind:mediaKind,name:job&&!m.assemblyId?`${job.modelName??(mediaKind==='image'?'生成图片':'生成视频')} · ${m.name??m.id}`:m.name,src:url,download:url+'?download=1',poster:job?.technicalQA?.frames?.[0]?.mediaId?'/api/media/'+job.technicalQA.frames[0].mediaId:m.assemblyId?url+'/preview?variant=thumb':undefined,bytes:m.bytes,created:job?.created??m.created,owner:m.owner,ownerName:app.store.get('user',m.owner)?.name,source:m.assemblyId?'本机拼接':m.generated?'生成结果':m.scope==='project'?'项目文件':'聊天素材',model:job?.modelName,seconds:job?.technicalQA?.duration,width:job?.technicalQA?.width,height:job?.technicalQA?.height});
 }
 for(const path of session?[]:Object.keys(ws.projects.revision(revision).manifest)){
  const fileKind=kindOf(path);if(paths.has(path)||!fileKind||kind!=='all'&&fileKind!==kind)continue;
  const info=ws.projects.fileInfo(path,revision),query=new URLSearchParams({project,path,revision}),url='/api/file-content?'+query;
  items.push({id:'file:'+path,kind:fileKind,name:basename(path),src:url,download:url+'&download=1',bytes:info.bytes,source:'项目文件',path});
 }
 for(const u of owners){
  const key=hash(JSON.stringify([u.id,project])).slice(0,24);if(!existsSync(join(app.store.root,'native-harness',key,'state/sessions')))continue;
  try{const data=await app.native.history.gallery(key);if(data.errors?.length)warnings.push(`${u.name} 的部分聊天附件暂未读取，可刷新重试。`);
   for(const ref of data.items??[]){const refKind=kindOf(ref.name??'',ref.mime);if(!refKind||kind!=='all'&&refKind!==kind||session&&ref.session!==session)continue;const query=new URLSearchParams({project,owner:u.id,session:ref.session,attachmentId:ref.attachmentId,name:ref.name??''}),url='/api/gallery/attachment?'+query;
    items.push({id:'attachment:'+u.id+':'+ref.session+':'+ref.attachmentId+':'+(ref.name??''),kind:refKind,name:ref.name||(kind==='image'?'聊天图片':'聊天视频'),src:url,download:url+'&download=1',bytes:ref.bytes,created:ref.time,owner:u.id,ownerName:u.name,source:'聊天附件',session:ref.session,width:ref.width,height:ref.height});}
  }catch{warnings.push(`${u.name} 的聊天附件暂不可读取，可刷新重试。`);}
 }
 requireThat(app.store.get('user',user.id)?.active&&app.store.get('user',user.id)?.role===user.role,'登录身份已变更',403);
 const unique=[...new Map(items.map(v=>[v.id,v])).values()].filter(v=>!q||[v.name,v.ownerName,v.model,v.path].filter(Boolean).join(' ').toLowerCase().includes(q)).sort((a,b)=>(session?1:-1)*String(a.created??'').localeCompare(String(b.created??''))||a.id.localeCompare(b.id));
 const raw=params.get('page')??'1';requireThat(/^\d+$/.test(raw)&&Number.isSafeInteger(Number(raw)),'页码无效');const pages=Math.max(1,Math.ceil(unique.length/100)),page=Math.max(1,Math.min(pages,Number(raw)));
 return {items:options.all?unique:unique.slice((page-1)*100,page*100),pagination:{page,pages,total:unique.length,limit:100},warnings,owners:app.store.all('user').filter(u=>user.role==='admin'||u.id===user.id).map(u=>({id:u.id,name:u.name})),kind,project};
}
