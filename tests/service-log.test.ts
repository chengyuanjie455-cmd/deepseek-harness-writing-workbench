import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RotatingLog} from '../server/service-log.ts';
test('log rotation retains ordered complete chunks in bounded managed files',()=>{
 const root=mkdtempSync(join(tmpdir(),'rotating-log-')),file=join(root,'service.log');const log=new RotatingLog(file,12,2);
 try{for(let n=0;n<6;n++)log.write('line'+n+'\n');assert.equal(readFileSync(file,'utf8'),'line4\nline5\n');assert.equal(readFileSync(file+'.1','utf8'),'line2\nline3\n');assert.equal(readFileSync(file+'.2','utf8'),'line0\nline1\n');log.write('line6\n');assert.equal(readdirSync(root).length,3);assert.equal(readFileSync(file+'.2','utf8'),'line2\nline3\n');}finally{log.close();rmSync(root,{recursive:true,force:true});}
});
