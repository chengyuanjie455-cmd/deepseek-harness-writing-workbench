import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {loadIncidentConfig} from '../server/incident-config.ts';
import {prepareRepairWorkspace} from '../server/incident-codex.ts';
test('desktop and normal hosts load persistent incident config and explicit override without embedding credentials',()=>{
 const root=mkdtempSync(join(tmpdir(),'incident-config-'));
 try{
  assert.equal(loadIncidentConfig(root,''),undefined);
  const config={enabled:true,concurrency:1,codex:{command:'/host/codex',home:'/host/maintenance'}};
  writeFileSync(join(root,'incident-config.json'),JSON.stringify(config));assert.deepEqual(loadIncidentConfig(root,''),config);
  const override=join(root,'override.json');writeFileSync(override,JSON.stringify({enabled:false}));assert.deepEqual(loadIncidentConfig(root,override),{enabled:false});
  writeFileSync(override,'[]');assert.throws(()=>loadIncidentConfig(root,override),/JSON 对象/);
  assert.throws(()=>loadIncidentConfig(root,join(root,'missing')));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('production repair includes versioned server data but excludes private root runtime data',()=>{
 const root=mkdtempSync(join(tmpdir(),'incident-source-')),source=join(root,'original'),work=join(root,'repair'),evidence=join(root,'evidence');
 try{
  for(const dir of [join(source,'server/data'),join(source,'data'),evidence])mkdirSync(dir,{recursive:true});
  writeFileSync(join(source,'server/data/contracts.json'),'{}');writeFileSync(join(source,'data/private.json'),'private');
  prepareRepairWorkspace(source,work,evidence);
  assert(existsSync(join(work,'source/server/data/contracts.json')));assert(!existsSync(join(work,'source/data/private.json')));
 }finally{rmSync(root,{recursive:true,force:true});}
});
