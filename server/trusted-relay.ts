import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isIP} from 'node:net';
import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {requireThat} from './store.ts';

/** Only the pinned cloud gateway may describe a client behind the SSH tunnel. */
export class TrustedRelay {
  private config?: {origin:string;token:string};
  constructor(dataDir:string) {
    const file=join(dataDir,'trusted-relay.json');
    if(!existsSync(file))return;
    const config=JSON.parse(readFileSync(file,'utf8'));
    const url=new URL(config.origin);
    requireThat(config.version===1&&url.protocol==='https:'&&url.origin===config.origin&&!url.username&&!url.password&&/^[a-f0-9]{64}$/.test(config.token),'中转配置无效');
    this.config=config;
  }
  context(req:IncomingMessage):{clientAddress:string;origin:string}|undefined {
    const supplied=req.headers['x-wawu-relay-token'];
    if(supplied===undefined)return;
    const config=this.config;
    requireThat(config&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??''),'中转入口未授权',403);
    requireThat(typeof supplied==='string'&&supplied.length===config.token.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(config.token)),'中转入口未授权',403);
    const client=req.headers['x-wawu-client-ip'];
    requireThat(typeof client==='string'&&!!isIP(client)&&req.headers['x-wawu-public-origin']===config.origin,'中转来源无效',403);
    return {clientAddress:client,origin:config.origin};
  }
}
