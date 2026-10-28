import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import YAML from 'yaml';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url);
// Ship the complete pinned native compositions as runtime data, rather than
// depending on a second node_modules tree inside an installed host package.
// Preserve Loader expressions for the container's platform, without eval.
const presets=[];
for(const name of ['standard','cordis','ptc','minimal']){
 const value=YAML.parse(readFileSync(resolve(root,'native-harness/node_modules/@deepseek-ai/dsh-web-app/presets',name+'.patch.yml'),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:value=>({__jsExpr:value})}]});
 const row=value?.[0]?.insert?.find(row=>row.name==='@deepseek-ai/dsh-agent-preset');
 if(!row?.id||!Array.isArray(row.config?.plugins))throw Error('Pinned native preset structure changed: '+name);
 // Match the existing preserve-team-tools.mjs image patch exactly.
 if(['standard','cordis'].includes(name)){
  const visit=rows=>{for(const p of rows){if(p.id==='tool-ralph'&&p.name==='@deepseek-ai/dsh-tool-ralph')p.disabled=false;if(Array.isArray(p.config))visit(p.config);}};
  visit(row.config.plugins);
 }
 presets.push(row);
}
writeFileSync(resolve(root,'native-harness/context-presets.json'),JSON.stringify(presets,null,2)+'\n');
execFileSync(require.resolve('esbuild/bin/esbuild'),[
 'web/native-studio.tsx','--bundle','--format=cjs','--platform=browser','--target=es2022',
 '--loader:.svg=dataurl','--external:react','--external:react-dom','--external:react-dom/client','--external:react/jsx-runtime',
 '--outfile=native-harness/team-project/studio.cjs'
],{cwd:root,stdio:'inherit'});
