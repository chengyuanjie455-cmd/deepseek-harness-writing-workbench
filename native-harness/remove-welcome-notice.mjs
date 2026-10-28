import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

// The team host provisions model access before login. Remove only the upstream
// preview notice step; do not record a user acknowledgement or disable settings.
const filename=resolve(process.argv[2]??'/opt/harness/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js');
const marker='// Team deployment: preview notice step omitted; model onboarding preserved.';
const source=readFileSync(filename,'utf8');
if(source.includes(marker)){
  console.log('Team preview notice already omitted.');
}else{
  const registration=/(?:if \(!\("dshDesktop" in globalThis\)\) )?ctx\.slots\.inject\("settings\.onboarding", \(\) => ctx\.slots\.register\(\{\s*name: "settings\.onboarding",\s*id: "welcome-notice",\s*order: -100,\s*inject: welcomeInjected\s*\}, WelcomeNotice\)\);/g;
  const matches=[...source.matchAll(registration)];
  if(matches.length!==1)throw new Error('Upstream welcome registration changed; inspect the new UI before rebuilding.');
  if(!source.includes('id: "deepseek-official"'))throw new Error('Expected model onboarding registration is missing.');
  writeFileSync(filename,source.replace(registration,marker));
  console.log('Removed team preview notice; model settings and credential onboarding preserved.');
}
