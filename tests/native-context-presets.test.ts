import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {nativeContextPresetPatch} from '../server/native-context-presets.ts';
const root=fileURLToPath(new URL('..',import.meta.url)),policy={provider:'deepseek-official',model:'small',thresholdRatio:0.8,retainRatio:0.16,headroomTokens:512,maxTokens:1024};
const parse=(s:string)=>YAML.parse(s,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(v:string)=>({__jsExpr:v})}]});
function flatten(rows:any[]):any[]{return rows.flatMap(r=>[r,...(Array.isArray(r.config)?flatten(r.config):[])]);}
test('context policies reach every shipped compaction-owning preset without replacing other native tools',()=>{
 const patch=nativeContextPresetPatch(root,'[]',[policy]);assert.deepEqual(patch.map(v=>v.id),['preset-standard','preset-cordis','preset-ptc']);
 for(const name of ['standard','cordis','ptc']){
  const original=parse(readFileSync(new URL('../native-harness/node_modules/@deepseek-ai/dsh-web-app/presets/'+name+'.patch.yml',import.meta.url),'utf8'))[0].insert[0].config.plugins;
  if(name!=='ptc')for(const row of flatten(original))if(row.id==='tool-ralph')row.disabled=false;
  const value=patch.find(p=>p.id==='preset-'+name)!.config.plugins,copy=structuredClone(value),compaction=flatten(copy).find(p=>p.name==='@deepseek-ai/dsh-compaction-basic');
  assert.equal(patch.find(p=>p.id==='preset-'+name)!.config.id,name,'Loader replaces the config object, so preset identity must be present');
  assert.deepEqual(compaction.config.modelPolicies,[policy]);delete compaction.config;
  assert.deepEqual(copy,original,'all other native configuration, expressions, order and disabled rows must be retained');
  assert(JSON.stringify(value).includes('__jsExpr'),'execution-environment expressions must stay unevaluated');
 }
 assert(!patch.some(v=>v.id==='preset-minimal'),'minimal intentionally provides no compaction service');
});
test('profile-edited and custom presets retain unrelated plugins, settings and unknown model policies',()=>{
 const plugin={id:'custom-plugin',name:'synthetic-custom',disabled:{__jsExpr:'process.platform !== "linux"'},config:{keep:'unchanged'}};
 const plugins=[plugin,{id:'group',name:'cordis:group',config:[{id:'different-id',name:'@deepseek-ai/dsh-compaction-basic',config:{auto:false,maxOverflowRetries:0,modelPolicies:[{provider:'other',model:'other',maxTokens:22},{...policy,maxTokens:9999,retainRatio:undefined,retainTokens:200,summarizationModel:'custom-summary',summarizationProvider:'custom'}]}}]}];
 const profile=JSON.stringify([{id:'preset-standard',config:{plugins}},{insert:[{id:'preset-group',name:'cordis:group',config:[{id:'my-preset',name:'@deepseek-ai/dsh-agent-preset',config:{id:'custom',plugins}}]}]}]);
 const before=profile,patch=nativeContextPresetPatch(root,profile,[policy]);assert.equal(profile,before);
 for(const key of ['preset-standard','my-preset']){
  const value=patch.find(v=>v.id===key)!.config.plugins;assert.deepEqual(value[0],plugin);const c=flatten(value).find(v=>v.name==='@deepseek-ai/dsh-compaction-basic').config;
  assert.equal(patch.find(v=>v.id===key)!.config.id,key==='my-preset'?'custom':'standard');
  assert.equal(c.auto,false);assert.equal(c.maxOverflowRetries,0);assert.equal(c.modelPolicies[0].model,'other');assert.equal(c.modelPolicies[1].maxTokens,1024);assert.equal(c.modelPolicies[1].retainTokens,undefined);assert.equal(c.modelPolicies[1].summarizationModel,'custom-summary');
 }
 assert.deepEqual(nativeContextPresetPatch(root,'[]',[]),[]);
 assert.throws(()=>nativeContextPresetPatch(root,'invalid-profile',[policy]),/格式无效/);
});
