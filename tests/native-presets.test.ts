import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import YAML from 'yaml';

test('native preset patch retains working Ralph modes without enabling an unmet dependency in PTC',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-presets-')),presets=join(root,'node_modules/@deepseek-ai/dsh-web-app/presets');
 try{
  mkdirSync(presets,{recursive:true});
  for(const name of ['standard','cordis','ptc','minimal'])cpSync(new URL('../native-harness/node_modules/@deepseek-ai/dsh-web-app/presets/'+name+'.patch.yml',import.meta.url),join(presets,name+'.patch.yml'));
  const unchanged=['ptc','minimal'].map(name=>readFileSync(join(presets,name+'.patch.yml'),'utf8'));
  cpSync(new URL('../native-harness/preserve-team-tools.mjs',import.meta.url),join(root,'preserve-team-tools.mjs'));
  execFileSync(process.execPath,[join(root,'preserve-team-tools.mjs')]);
  function rows(value:any):any[]{if(Array.isArray(value))return value.flatMap(rows);if(value&&typeof value==='object')return [value,...Object.values(value).flatMap(rows)];return [];}
  for(const name of ['standard','cordis']){const preset=rows(YAML.parse(readFileSync(join(presets,name+'.patch.yml'),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>value}]}));assert.equal(preset.find(v=>v.id==='tool-ralph')!.disabled,false);assert.notEqual(preset.find(v=>v.id==='workflow-ptc')!.disabled,true);}
  for(const [index,name] of ['ptc','minimal'].entries())assert.equal(readFileSync(join(presets,name+'.patch.yml'),'utf8'),unchanged[index]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
