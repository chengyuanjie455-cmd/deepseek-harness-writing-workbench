import {randomBytes} from 'node:crypto';
import {hash, now, requireThat, type Doc} from './store.ts';
import type {Store} from './store.ts';
import type {IncomingMessage} from 'node:http';

/** Revocable device credential, separate from browser cookies and never a Hub root token. */
export class MobileIdentity {
  constructor(private store:Store, private serverId:string) {}
  namespace(userId:string) { return 'wawu-'+hash(JSON.stringify([this.serverId,userId])).slice(0,32); }
  issue(user:Doc,label:string) {
    requireThat(this.store.get('user',user.id)?.active&&this.store.get('user',user.id)?.accountGatewayAllowed!==false,'账号已停用',401);
    requireThat(typeof label==='string' && label.trim().length>0 && label.length<=80,'设备名称无效',400);
    const token='wawu_'+randomBytes(32).toString('base64url'),id=hash(token);
    const grant={id,owner:user.id,role:user.role,credentialVersion:hash(user.password),label:label.trim(),expires:Date.now()+30*86400000,created:now(),revoked:false};
    this.store.put('mobile-device',grant);this.store.audit(user.id,'mobile.device.pair',id,{label:grant.label});
    return {...this.public(grant),token,namespace:this.namespace(user.id),serverId:this.serverId};
  }
  public(grant:Doc){return {id:grant.id,label:grant.label,expires:grant.expires,created:grant.created,revoked:grant.revoked};}
  authenticate(req:IncomingMessage) {
    const raw=req.headers.authorization?.match(/^Bearer (wawu_[A-Za-z0-9_-]{43})$/)?.[1];
    requireThat(raw,'请重新配对工作台账号',401);
    const grant=this.store.get('mobile-device',hash(raw));
    const user=grant&&this.store.get('user',grant.owner);
    requireThat(grant && !grant.revoked && grant.expires>Date.now() && user?.active && user.accountGatewayAllowed!==false && user.role===grant.role && grant.credentialVersion===hash(user.password),'手机连接已过期、解除配对或账号已停用，请在原工作台重新配对',401);
    return {user:user!,auth:{user_id:user!.id,expires:grant!.expires,csrf:'',mobileDeviceId:grant!.id},grant:grant!};
  }
  revoke(user:Doc,id:string) {
    const grant=this.store.get('mobile-device',id);requireThat(grant&&grant.owner===user.id,'设备不存在',404);
    this.store.put('mobile-device',{...grant,revoked:true});this.store.audit(user.id,'mobile.device.revoke',id);return {revoked:true};
  }
}
