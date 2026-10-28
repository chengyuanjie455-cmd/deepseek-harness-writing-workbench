import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloneFileSync} from '../server/clone-file.ts';
test('workspace clones preserve bytes and independent member edits, including Unicode paths',()=>{
 const root=mkdtempSync(join(tmpdir(),'clone-workspace-'));
 try{const source=join(root,'原图 $ .bin'),one=join(root,'成员一.bin'),two=join(root,'成员二.bin');const bytes=Buffer.alloc(3*1024*1024,17);writeFileSync(source,bytes);cloneFileSync(source,one);cloneFileSync(source,two);assert.deepEqual(readFileSync(one),bytes);assert.notEqual(statSync(source).ino,statSync(one).ino);writeFileSync(one,'member change');assert.deepEqual(readFileSync(source),bytes);assert.deepEqual(readFileSync(two),bytes);assert.throws(()=>cloneFileSync(join(root,'missing'),two));assert.deepEqual(readFileSync(two),bytes);}finally{rmSync(root,{recursive:true,force:true});}
});
