import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,type Doc} from '../server/store.ts';
import {ChatCatalog} from '../server/chat-catalog.ts';

test('skill catalog publishes screenwriter by default and exposes no host source',()=>{
 const root=mkdtempSync(join(tmpdir(),'skill-catalog-')),store=new Store(root);try{
  const catalog=new ChatCatalog(store),member={id:'member',role:'member',active:true},admin={id:'admin',role:'admin',active:true};
  const options=catalog.options(member,'project');assert.equal(options.defaultSkillId,'screenwriter');assert.deepEqual(options.skills.map((s:Doc)=>s.id),['screenwriter','video-storyboard']);assert.equal(JSON.stringify(options).includes('主机上的编剧技能'),false);assert.equal((catalog.select(member,'project',undefined,undefined,'screenwriter') as Doc).skillId,'screenwriter');
  catalog.skills.savePolicy(admin,'project',{skillIds:['screenwriter'],defaultSkillId:'screenwriter'});assert.deepEqual(catalog.options(member,'project').skills.map((s:Doc)=>s.id),['screenwriter']);assert.throws(()=>catalog.select(member,'project',undefined,undefined,'video-storyboard'),/未发布|未向当前项目开放/);
  assert.throws(()=>catalog.skills.savePolicy(member,'project',{skillIds:['screenwriter'],defaultSkillId:'screenwriter'}),/超级管理员/);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
