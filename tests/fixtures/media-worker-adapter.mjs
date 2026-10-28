import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
const root=process.env.PLATFORM_DATA;
function count(name){const file=join(root,name);const n=existsSync(file)?Number(readFileSync(file,'utf8')):0;writeFileSync(file,String(n+1));return n+1;}
export const videoAdapter={
 async create(_c,_key,_payload,signal){const n=count('fixture-video-creates');while(!existsSync(join(root,'fixture-release')))await delay(20,undefined,{signal});if(existsSync(join(root,'fixture-unknown')))throw Error('synthetic uncertain receipt');return {id:'synthetic-'+n,status:'queued'};},
 async query(_c,_key,id){count('fixture-video-queries');return {id,status:'completed'};},
 async content(){return new Response(readFileSync(join(root,'fixture.mp4')),{headers:{'content-type':'video/mp4'}});}
};
export const imageAdapter={async create(){count('fixture-image-creates');while(existsSync(join(root,'fixture-image-wait')))await delay(20);return {data:[{url:'https://synthetic.invalid/image'}]};},async download(){const n=count('fixture-image-downloads');if(n===1&&existsSync(join(root,'fixture-download-fail-once')))throw Error('synthetic interrupted download');return Readable.from([readFileSync(join(root,'fixture.png'))]);}};
