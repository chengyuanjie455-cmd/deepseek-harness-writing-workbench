import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseDocument} from 'yaml';
import {hash} from '../server/store.ts';
import {verifyNativeCompatibility} from '../server/native-compatibility.ts';
const root=resolve('.'),base=join(root,'native-harness/node_modules/@deepseek-ai');
const names=['dsh-base','dsh-web-app'];
const rows=new Map<string,any>(),sources:any[]=[];
function visit(items:any[],bundle:string){for(const row of items??[]){if(!row||typeof row!=='object')continue;if(row.insert)visit(Array.isArray(row.insert)?row.insert:[row.insert],bundle);if(typeof row.id==='string')rows.set(row.id,{...rows.get(row.id),...row,bundle});}}
for(const name of names){
 const path=join(base,name,'cordis.patch.yml'),text=readFileSync(path,'utf8');
 const parsed=parseDocument(text,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(source:string)=>({expression:source})}]});
 if(parsed.errors.length)throw Error('Native profile parse failed: '+name);
 visit(parsed.toJS(),name);sources.push({path,sha256:hash(text)});
}
const plugins=[...rows.values()].filter(r=>r.name).map(r=>{
 const pkg=r.name.replace(/^(\@[^/]+\/[^/]+).*$/,'$1'),file=join(root,'native-harness/node_modules',pkg,'package.json');
 const installed=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):undefined;
 return {id:r.id,package:r.name,declaredIn:r.bundle,activation:r.disabled===true?'disabled_by_official_profile':r.disabled&&typeof r.disabled==='object'?'conditional':'declared',installedVersion:installed?.version??null,installed:!!installed,runtimeLoaded:'not_checked',functionalAcceptance:'not_executed'};
});
const team=JSON.parse(readFileSync(join(root,'native-harness/package.json'),'utf8'));
console.log(JSON.stringify({profile:'web',version:team.dependencies['@deepseek-ai/dsh'],sources,plugins,declaredPluginCount:plugins.length,compatibility:verifyNativeCompatibility(root),note:'Static official base+web declaration inventory. Runtime conditions, team overlay, agent presets and commands/tools require separate inspection; this is not a full functionality pass. No plugins or models were executed.'},null,2));
