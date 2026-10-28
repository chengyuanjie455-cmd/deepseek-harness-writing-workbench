import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Platform} from '../server/app.ts';
import {ChatCatalog} from '../server/chat-catalog.ts';

test('removed provider excludes initial and saved models across projects and restart without touching history',async()=>{
 const root=mkdtempSync(join(tmpdir(),'removed-provider-'));
 const original={provider:'opencode-zen',model:'glm-5.3-flash',reasoningEffort:'high',baseURL:'https://opencode.ai/zen/v1',apiKey:'fixture-opencode-key',configId:'old-default'} as const;
 const glm={...original,provider:'zhipu-coding',baseURL:'https://open.bigmodel.cn/api/coding/paas/v4',apiKey:'fixture-coding-key',configId:'coding'};
 writeFileSync(join(root,'chat-model-connections.json'),JSON.stringify([{id:'old-model',name:'OpenCode',enabled:true,connection:{...original,configId:'old-saved'}},{id:'coding',name:'ZCode',enabled:true,connection:glm}]));
 writeFileSync(join(root,'chat-provider-removals.json'),JSON.stringify(['opencode-zen']));
 const app=new Platform({dataDir:root,model:original});
 try {
  const member=app.newUser({username:'member',password:'Fixture-only-password-123!'},'member');
  const history={id:'existing-history',owner:member.id,content:'Preserved user content'};app.store.put('message',history);
  for(const catalog of [app.catalog,new ChatCatalog(app.store,original)]){
   for(const project of ['shared','another-project']){
    assert.deepEqual(catalog.available(member,project).map(m=>m.id),['coding']);
    assert.deepEqual(catalog.policy(project).modelIds,['coding']);
    assert.equal(catalog.select(member,project).modelId,'coding');
    for(const removed of ['default','old-model'])assert.throws(()=>catalog.select(member,project,removed),/未启用/);
   }
   for(const old of ['old-default','old-saved'])assert.throws(()=>catalog.connection(old),/重新选择/);
   assert.equal(catalog.connection('coding')?.provider,'zhipu-coding');
   assert.throws(()=>catalog.saveModel(member,{name:'OpenCode',...original,enabled:true}),/已移除/);
   assert(!JSON.stringify(catalog.publicModels()).includes('fixture-coding-key'));
  }
  assert.deepEqual(app.store.get('message',history.id),history);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
