import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import YAML from 'yaml';
import {requireThat,type Doc} from './store.ts';

// Loader's public JsExpr representation. Preserve the expression for the native
// execution environment; never evaluate a Linux preset on the macOS host.
function parse(text:string){
 const value=YAML.parse(text,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>({__jsExpr:value})}]});
 requireThat(Array.isArray(value),'原生预设配置格式无效',503);return value as Doc[];
}
function entries(rows:Doc[]):Doc[]{return rows.flatMap(row=>[row,...(Array.isArray(row.insert)?entries(row.insert):[]),...(Array.isArray(row.config)?entries(row.config):[])]);}
function patchPlugins(plugins:Doc[],policies:Doc[]):number{
 let count=0;
 for(const row of plugins){
  if(row.name==='@deepseek-ai/dsh-compaction-basic'){
   const old=row.config?.modelPolicies??[];requireThat(Array.isArray(old),'原生上下文策略格式无效',503);
   const merged=old.filter((p:Doc)=>!policies.some(n=>n.provider===p.provider&&n.model===p.model));
   for(const policy of policies){const previous=old.find((p:Doc)=>p.provider===policy.provider&&p.model===policy.model)??{};const next={...previous,...policy};if(policy.retainRatio!==undefined)delete next.retainTokens;merged.push(next);}
   row.config={...row.config,modelPolicies:merged};count++;
  }
  if(Array.isArray(row.config))count+=patchPlugins(row.config,policies);
 }
 return count;
}
/** Web 0.2 mounts compaction inside each Agent preset and disables the host
 * copy. Override the complete existing composition, changing only its native
 * compaction config. A fragment would silently remove all other native tools.
 * The persisted profile file is read-only and user compositions take priority. */
export function nativeContextPresetPatch(codeRoot:string,profilePatch:string,policies:Doc[]){
 if(!policies.length)return [];
 const presets=new Map<string,Doc>(),builtins=JSON.parse(readFileSync(join(codeRoot,'native-harness/context-presets.json'),'utf8'));
 requireThat(Array.isArray(builtins)&&builtins.length===4,'原生上下文预设尚未构建',503);
 for(const row of builtins){
  requireThat(row?.id&&Array.isArray(row.config?.plugins),'原生预设组合接口变化',503);
  presets.set(row.id,row);
 }
 // Native Web stores full edited plugin lists in the profile patch. Keep those
 // lists, names, disabled rows and expressions, including custom presets.
 for(const row of entries(parse(profilePatch))){
  if(!row.id||!Array.isArray(row.config?.plugins))continue;
  if(presets.has(row.id)||row.name==='@deepseek-ai/dsh-agent-preset'){
   const previous=presets.get(row.id);presets.set(row.id,{...previous,...structuredClone(row),config:{...previous?.config,...structuredClone(row.config)}});
  }
 }
 const result:Doc[]=[];
 for(const [id,row] of presets){const plugins=structuredClone(row.config.plugins);if(patchPlugins(plugins,policies))result.push({id,config:{...row.config,plugins}});}
 return result;
}
