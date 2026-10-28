import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Platform} from '../../server/app.ts';
import {removeNativeContainer} from '../../server/native-container.ts';

/** Only remove exact containers owned by this temporary Platform. Never sweep
 * the daemon or touch the formal workbench's account/container records. */
export async function closeNativeFixture(app:Platform){
 const own=[...app.native.instances.values()].filter(i=>i.name&&i.root.startsWith(app.store.root+'/')).map(i=>i.name);
 const users=app.store.all('user'),evidence=process.env.NATIVE_FIXTURE_EVIDENCE;
 const proof={root:app.store.root,nativeProjectSurface:app.native.projectSurface,ownedContainerNames:own,temporaryAccountsDisabled:users.length,servicesClosed:false,ownedContainersRemoved:0};
 const save=()=>{if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'cleanup.json'),JSON.stringify(proof,null,2));}};
 for(const u of users)app.store.put('user',{...u,active:false});
 save();
 await app.close();
 proof.servicesClosed=true;save();
 if(!own.length)return;
 const docker=['/opt/homebrew/bin/docker','/usr/local/bin/docker','/Applications/Docker.app/Contents/Resources/bin/docker'].find(existsSync);
 if(!docker)throw Error('Docker missing during owned fixture cleanup');
 const run=promisify(execFile);
 for(const name of own){await removeNativeContainer(name,args=>run(docker,args,{timeout:15000}));proof.ownedContainersRemoved++;save();}
 console.log(JSON.stringify({fixtureCleanup:true,ownedContainersRemoved:own.length,temporaryAccountsDisabled:true}));
}
