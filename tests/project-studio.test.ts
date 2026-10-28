import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildStudioCatalogue,episodeKey,filterStudio,mergeStudioCatalogueDetails,mergeStudioSearch,initialStudioPage,projectMediaURL,studioDocumentKey,studioDocumentRequest,projectSection,studioGalleryPage} from '../shared/project-studio.ts';

test('large gallery paging preserves every original identity, clamps after filtering, and never mutates the catalogue',()=>{
 const items=Array.from({length:512},(_,n)=>({id:'asset-'+n,sha256:'sha-'+n})),before=JSON.stringify(items);
 const pages=Array.from({length:11},(_,n)=>studioGalleryPage(items,n+1));assert.equal(pages[0].items.length,48);assert.equal(pages[10].items.length,32);assert.deepEqual(pages.flatMap(p=>p.items),items);assert.equal(new Set(pages.flatMap(p=>p.items.map(v=>v.id))).size,512);assert.equal(studioGalleryPage(items,999).page,11);
 const filtered=studioGalleryPage(items.slice(0,16),8);assert.equal(filtered.page,1);assert.equal(filtered.from,1);assert.equal(filtered.to,16);assert.equal(studioGalleryPage([],4).from,0);assert.equal(studioGalleryPage(items,NaN).page,1);assert.equal(JSON.stringify(items),before);
});

test('authoritative cleared shot links replace stale local path aliases rather than accumulating a false relationship',()=>{
 const local:any={id:'file:old-name',path:'旧名.md',name:'旧名.md',kind:'document',section:'storyboards',episodes:['EP001'],assetType:'character',sourceIds:['EP001-001']};
 const indexed:any={...local,id:'file:copy-identity',entityId:'copy-identity',episodes:[],sourceIds:[],relationships:[],episodeEvidence:'unassigned',section:'files',assetType:'other'};
 const result=mergeStudioCatalogueDetails([local],[indexed]);assert.deepEqual(result[0].episodes,[]);assert.deepEqual(result[0].sourceIds,[]);assert.deepEqual(result[0].relationships,[]);assert.equal(result[0].section,'files');assert.equal(result[0].assetType,'other');
});

test('first project entry includes authorized media before any media gallery has loaded',()=>{
 const files=buildStudioCatalogue([{path:'剧本/EP001.md'}]);
 const catalogue:any[]=[{id:'media:clip',mediaId:'clip',owner:'member-a',scope:'private',name:'EP001.mp4',kind:'video',section:'videos',episodes:['EP001'],assetType:'other',sha256:'original',src:'/api/media/clip',download:'/api/media/clip?download=1'},{id:'media:character',mediaId:'character',owner:'member-a',scope:'private',name:'角色.png',kind:'image',section:'assets',episodes:['EP001','EP002'],assetType:'character'}];
 const before=JSON.stringify([files,catalogue]),items=mergeStudioCatalogueDetails(files,catalogue);
 assert.equal(filterStudio(items,'videos','EP001').length,1);assert.equal(filterStudio(items,'assets','EP002','character').length,1);assert.equal(items.find(v=>v.mediaId==='clip')!.download,'/api/media/clip?download=1');assert.equal(items.find(v=>v.mediaId==='clip')!.scope,'private');assert.equal(JSON.stringify([files,catalogue]),before);
});

test('opening a lazy gallery later does not duplicate catalogue media, published originals or native attachment aliases',()=>{
 const values=buildStudioCatalogue([{path:'资产/角色.png'}],[{id:'gallery-clip',mediaId:'clip',name:'EP009.mp4',kind:'video'},{id:'legacy-upload',name:'上传.txt',kind:'document'}]);
 const catalogue:any[]=[{id:'file:stable',path:'资产/角色.png',mediaId:'character',name:'角色.png',kind:'image',section:'assets',episodes:['EP001'],assetType:'character',episodeEvidence:'explicit'},{id:'media:clip',mediaId:'clip',name:'EP009.mp4',kind:'video',section:'edits',episodes:[],assetType:'other',episodeEvidence:'explicit',classificationEvidence:'explicit'},{id:'attachment:canonical',galleryId:'legacy-upload',nativeAttachmentKey:'a'.repeat(64),name:'上传.txt',kind:'document',section:'scripts',episodes:[],assetType:'other'}];
 const items=mergeStudioCatalogueDetails(values,catalogue);
 assert.equal(items.length,3);assert.equal(items.filter(v=>v.mediaId==='character').length,1);assert.equal(items.filter(v=>v.mediaId==='clip').length,1);assert.equal(items.filter(v=>v.nativeAttachmentKey).length,1);assert.equal(items.find(v=>v.mediaId==='clip')!.section,'edits');assert.deepEqual(items.find(v=>v.mediaId==='clip')!.episodes,[]);assert.equal(filterStudio(items,'scripts').length,1);
});

test('a loaded gallery cannot turn canonical unassigned media into an episode merely because its name contains an episode number',()=>{
 const original:any={id:'media:clip',mediaId:'clip',name:'EP001-片段.mp4',kind:'video',section:'videos',episodes:[],episodeEvidence:'unassigned',assetType:'other',displayName:'公共 · 聊天素材 · EP001-片段.mp4'};
 const first=mergeStudioCatalogueDetails([],[original]),later=mergeStudioCatalogueDetails(buildStudioCatalogue([],[{id:'gallery-clip',mediaId:'clip',name:original.name,kind:'video'}]),[original]);
 assert.deepEqual(later[0].episodes,first[0].episodes);assert.equal(later[0].displayName,first[0].displayName);assert.equal(filterStudio(later,'videos','unassigned').length,1);assert.equal(filterStudio(later,'videos','EP001').length,0);
});

test('attachment preview uses its immutable native identity and project scope rather than inventing a published file path',()=>{
 const key='a'.repeat(64),item={id:'attachment:'+key,nativeAttachmentKey:key,versionId:'sha256:original',name:'剧本.docx',project:'shared'};
 assert.equal(studioDocumentRequest(item,'shared','current',120),'/native-attachments/'+key+'/text?project=shared&offset=120');assert.notEqual(studioDocumentKey(item,'shared','current'),studioDocumentKey({...item,versionId:'sha256:new'},'shared','current'));assert.equal(studioDocumentRequest(item,'another-project','current'),undefined);
 assert.equal(studioDocumentRequest({path:'剧本.md',revision:'found-old-revision'},'shared','current'),'/file?project=shared&path=%E5%89%A7%E6%9C%AC.md&revision=found-old-revision&offset=0');assert.equal(projectMediaURL('/api/native-attachments/'+key+'/content?download=1','shared'),'/api/native-attachments/'+key+'/content?download=1&project=shared');assert.equal(projectMediaURL('/api/native-attachments/'+key+'/content?project=other','shared'),undefined);
});

test('indexed attachment results and the legacy gallery alias display once while another upload remains available',()=>{
 const indexed:any={id:'attachment:canonical',galleryId:'attachment:legacy-upload',nativeAttachmentKey:'a'.repeat(64),name:'剧本片段.txt',kind:'document',section:'scripts',episodes:[],assetType:'other'},loaded:any={...indexed,id:'attachment:legacy-upload'},other:any={...loaded,id:'attachment:other-upload',galleryId:'attachment:other-upload',name:'剧本补充.txt'};assert.equal(mergeStudioSearch([indexed],[loaded,other],'files','all','all','剧本').length,2);assert.equal(mergeStudioSearch([indexed],[loaded],'files','all','all','剧本')[0].id,indexed.id);
});

test('episode recognition respects explicit episode IDs and never assigns a whole-season script to the last episode',()=>{
 assert.equal(episodeKey('EP040-015'), 'EP040');
 assert.equal(episodeKey('剧本/第02集.md'), 'EP002');
 assert.equal(episodeKey('第十二集'), 'EP012');
 assert.equal(episodeKey('1-78集分镜总稿.md'), undefined);
 assert.equal(episodeKey('角色/男主3号.png'), undefined);
 assert.equal(episodeKey('EP001/1-78集总稿.md'), 'EP001');
});
test('the screenplay index links shared assets to multiple episodes without moving or renaming original files',()=>{
 const files=[{path:'剧本总稿.md'},{path:'分镜/EP001.md'},{path:'人物/男主.png'},{path:'场景/厨房.png'},{path:'公共图.png'}];
 const index={shots:[{id:'EP001-001',episode:'第1集',scriptPath:'剧本总稿.md',storyboardPath:'分镜/EP001.md',assets:[{path:'人物/男主.png',role:'character'},{path:'场景/厨房.png',role:'scene'}]},{id:'EP002-002',episode:'第2集',scriptPath:'剧本总稿.md',assets:[{path:'人物/男主.png',role:'character'}]}]};
 const before=JSON.stringify(files),items=buildStudioCatalogue(files,[],[],index,'测试项目');
 assert.equal(JSON.stringify(files),before,'catalogue must not mutate source files');
 assert.deepEqual(items.find(v=>v.path==='人物/男主.png')!.episodes,['EP001','EP002']);
 assert.equal(items.find(v=>v.path==='场景/厨房.png')!.assetType,'scene');
 assert.equal(filterStudio(items,'assets','EP002','character').length,1);
 assert.equal(filterStudio(items,'assets','EP002','scene').length,0);
 assert.equal(filterStudio(items,'assets','unassigned').length,1);
 assert.equal(items.find(v=>v.path==='剧本总稿.md')!.section,'scripts');
});
test('video cards use the exact matching shot prompt and assets, retaining rounds and missing-provenance gaps',()=>{
 const plans=[{id:'plan',shots:[{source:{id:'EP002-003',episode:'第2集',scriptPath:'剧本/EP002.md'},prompt:'只拍人物A的单人近景。',assets:[{id:'A',mediaId:'asset-a',role:'character'}]},{source:{id:'EP003-001',episode:'第3集'},prompt:'不得串入这一条提示词。',assets:[]}],jobs:[{id:'job',mediaId:'clip-a',sourceId:'EP002-003',round:2,state:'ready'}]}];
 const items=buildStudioCatalogue([],[{id:'media:clip-a',mediaId:'clip-a',name:'原片.mp4',kind:'video'},{id:'media:legacy',mediaId:'legacy',name:'旧原片.mp4',kind:'video'}],plans);
 const clip=items.find(v=>v.mediaId==='clip-a')!;
 assert.deepEqual(clip.episodes,['EP002']);assert.equal(clip.prompt,'只拍人物A的单人近景。');assert.equal(clip.assets[0].mediaId,'asset-a');assert.equal(clip.round,2);
 assert.equal(items.find(v=>v.mediaId==='legacy')!.prompt,undefined);
});
test('finished episode edits are separate from original clips and miscellaneous files stay available',()=>{
 assert.equal(projectSection({path:'视频/EP001-001.mp4'}),'videos');
 assert.equal(projectSection({path:'剪辑/EP001_拼接.mp4'}),'edits');
 assert.equal(projectSection({path:'剪辑/EP001.fcpxml'}),'edits');
 assert.equal(projectSection({path:'资产/道具/钥匙.png'}),'assets');
 assert.equal(projectSection({path:'资料/协作说明.md'}),'files');
 const items=buildStudioCatalogue([{path:'视频/EP001-001.mp4'},{path:'剪辑/EP001_拼接.mp4'}]);
 assert.equal(filterStudio(items,'edits','EP001').length,1);
 assert.equal(filterStudio(items,'videos','EP001').length,1);
});
test('authenticated media links always keep project scope and reject other-project or external URLs',()=>{
 const url=projectMediaURL('/api/media/clip-1?download=1','project-a')!;
 assert.equal(new URL(url,'http://local').searchParams.get('project'),'project-a');
 assert.equal(new URL(url,'http://local').searchParams.get('download'),'1');
 assert.equal(projectMediaURL('/api/media/clip-1?project=project-b','project-a'),undefined);
 assert.equal(projectMediaURL('https://example.org/a.mp4','project-a'),undefined);
 assert.equal(projectMediaURL('//example.org/a.mp4','project-a'),undefined);
 assert.equal(projectMediaURL('/api/admin/keys','project-a'),undefined);
});
test('a fresh entry opens project management; an explicit project link can resume a workspace',()=>{
 assert.equal(initialStudioPage(''),'projects');
 assert.equal(initialStudioPage('?view=videos'),'projects');
 assert.equal(initialStudioPage('?project=shared'),'native');
});

test('video preview links keep current project scope and never accept a different project',()=>{assert(projectMediaURL('/api/media/clip-1/preview?variant=thumb','project-a')?.includes('project=project-a'));assert.equal(projectMediaURL('/api/media/clip-1/preview?project=project-b','project-a'),undefined);});

test('project full-text results retain loaded private upload name matches without treating them as indexed conversation bodies',()=>{const local=buildStudioCatalogue([],[{id:'attachment:owner:session:sha:name',name:'庭院人物参考图.png',kind:'image',source:'聊天附件'}]);const remote=buildStudioCatalogue([{path:'剧本/庭院.md'}]);const merged=mergeStudioSearch(remote,local,'files','all','all','庭院');assert.equal(merged.length,2);assert.equal(merged[1].matchScope,'attachment-name');assert.equal(mergeStudioSearch(remote,local,'scripts','all','all','庭院').length,1);assert.equal(mergeStudioSearch(remote,local,'files','all','all','未提取的私聊正文').length,1);});
