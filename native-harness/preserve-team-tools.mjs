// Preserve Ralph only where the shipped preset provides its workflow engine.
// PTC intentionally disables that engine and uses its own tool presentation;
// forcing Ralph there prevents the entire native preset from loading.
// Host-plane tool rows stay disabled to avoid duplicate tool registrations.
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
const root=new URL('./node_modules/@deepseek-ai/dsh-web-app/presets/',import.meta.url);
let changed=0;
for(const name of readdirSync(root).filter(n=>n.endsWith('.patch.yml'))){
 const path=new URL(name,root),before=readFileSync(path,'utf8');
 if(name==='ptc.patch.yml')continue;
 const after=before.replace(/(- id: tool-ralph\n[ \t]+name: '@deepseek-ai\/dsh-tool-ralph'\n[ \t]+disabled:) true/g,(_match,prefix)=>{changed++;return prefix+' false';});
 if(after!==before)writeFileSync(path,after);
}
if(changed!==2)throw Error('Unexpected upstream preset layout: '+changed);
console.log('Preserved Ralph in standard and cordis; kept the native PTC engine configuration.');
