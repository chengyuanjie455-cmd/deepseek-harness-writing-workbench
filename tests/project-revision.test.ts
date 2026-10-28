import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store,id,hash} from '../server/store.ts';import {Projects} from '../server/project.ts';import {objectInfo,objectPath} from '../server/file-objects.ts';
function fixture(){const root=mkdtempSync(join(tmpdir(),'revision-batches-')),store=new Store(root),projects=new Projects(store);return {root,store,projects};}

test('batched revision objects retain the legacy Git tree, raw text and binary stubs for unusual valid file names',()=>{
 const {root,store,projects:p}=fixture();try{
  const text=Buffer.from('第一行\r\n第二行\n'),binary=Buffer.from([137,80,78,71,13,10,26,10,0,255,9]),t=p.blob(text),b=p.blob(binary),manifest={'剧本/中文 空格.md':t,'剧本/含"引号.md':t,'资产/人物😀.png':b,'资产/同图.png':b,'资料/保持CRLF.md':t};
  const index=join(root,'recovery','expected-'+id()),env={GIT_INDEX_FILE:index};p.git(['read-tree','--empty'],true,undefined,env);
  for(const path of Object.keys(manifest).sort()){const digest=manifest[path as keyof typeof manifest],info=objectInfo(root,digest),oid=info.text?p.git(['hash-object','-w','--no-filters','--',objectPath(root,digest)]):p.git(['hash-object','-w','--stdin'],true,`team-file-v1\nsha256 ${digest}\nbytes ${info.bytes}\n`);p.git(['update-index','--add','--cacheinfo',`100644,${oid},${path}`],true,undefined,env);}
  const expected=p.git(['write-tree'],true,undefined,env),revision=p.makeRevision(manifest,p.current().revision);
  assert.equal(p.git(['show','--format=%T','--no-patch',revision.id]),expected);
  for(const [path,digest] of Object.entries(manifest)){assert.deepEqual(readFileSync(join(root,'snapshots',revision.id,path)),readFileSync(objectPath(root,digest)));assert.equal(hash(readFileSync(objectPath(root,digest))),digest);}
  assert.deepEqual(revision.manifest,manifest);
 }finally{store.close();}
});

test('large revision writes use bounded batches instead of starting Git once per file',()=>{
 const {store,projects:p}=fixture();try{
  const manifest=Object.fromEntries(Array.from({length:300},(_,n)=>['资料/'+('长'.repeat(50))+n+'.md',p.blob('独立资料 '+n)])),calls:{command:string;inputBytes:number}[]=[],original=p.git.bind(p);
  p.git=(args,bare=true,input,env={})=>{calls.push({command:args[0],inputBytes:Buffer.byteLength(input??'')});return original(args,bare,input,env);};
  const revision=p.makeRevision(manifest,p.current().revision);assert.equal(Object.keys(revision.manifest).length,300);
  assert(calls.filter(c=>c.command==='hash-object').length<=3,'hash objects should be processed as bounded groups');assert(calls.filter(c=>c.command==='update-index').length<=3,'index entries should be processed as bounded groups');assert(calls.every(c=>c.inputBytes<=48*1024),'no large synchronous stdin payload');
 }finally{store.close();}
});

test('an invalid batched object receipt does not publish a revision or alter existing originals',()=>{
 const {root,store,projects:p}=fixture();try{
  const before=p.current().revision,manifest:Record<string,string>={...p.revision().manifest,'资产/失败.png':p.blob(Buffer.from([137,80,78,71,13,10,26,10,0,1]))},revisionCount=store.all('revision').length,original=p.git.bind(p);
  p.git=(args,bare=true,input,env={})=>args[0]==='hash-object'?'not-an-object-id':original(args,bare,input,env);
  assert.throws(()=>p.makeRevision(manifest,before),/版本对象写入回执无效/);assert.equal(p.current().revision,before);assert.equal(store.all('revision').length,revisionCount);assert.equal(p.git(['rev-parse','refs/heads/main']),before);
  assert(!readdirSync(join(root,'recovery')).some(n=>n.startsWith('git-objects-')));for(const digest of Object.values(manifest))assert(existsSync(objectPath(root,digest)));
 }finally{store.close();}
});
