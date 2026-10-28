import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {conversationFilePath} from '../server/host-files.ts';

test('workspace bindings accept OS aliases, canonical paths and missing write targets without accepting escaping links',()=>{
 const base=mkdtempSync(join(tmpdir(),'conversation-path-'));
 try{
  const root=join(base,'native'),real=join(base,'real-work');mkdirSync(root);mkdirSync(real);
  const work=join(root,'workspace');symlinkSync(real,work);writeFileSync(join(real,'原图.png'),'original');
  const i={root,work},canonical=realpathSync(real);
  assert.equal(conversationFilePath('/workspace/原图.png',i),join(canonical,'原图.png'));
  assert.equal(conversationFilePath(join(work,'原图.png'),i),join(canonical,'原图.png'));
  assert.equal(conversationFilePath(join(canonical,'原图.png'),i),join(canonical,'原图.png'));
  assert.equal(conversationFilePath('/workspace/新目录/新文件.txt',i),join(canonical,'新目录/新文件.txt'));
  const outside=join(base,'outside');mkdirSync(outside);symlinkSync(outside,join(real,'escape'));
  for(const p of ['/workspace/escape/new.txt','/workspace/../outside','/etc/passwd'])assert.throws(()=>conversationFilePath(p,i));
  assert.throws(()=>conversationFilePath('/workspace/new.txt',{root,work:join(base,'missing')}),/不存在|磁盘/);
 }finally{rmSync(base,{recursive:true,force:true});}
});
