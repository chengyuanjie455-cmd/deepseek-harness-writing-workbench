import {createHash} from 'node:crypto';

// Only bundled executable/style/font resources are reusable. HTML contains
// credentials; project files, API responses and generated media never enter here.
export function nativeStaticPath(method:string,path:string){
 return method==='GET'&&/^\/(?:plugins|assets)\/[\w@%./+-]+\.(?:js|mjs|css|woff2?)(?:\?[^#]*)?$/.test(path);
}
type Asset={body:Buffer;type:string;etag:string;expires:number};
export class NativeStaticCache {
 private entries=new Map<string,Asset>();private bytes=0;
 constructor(private maxBytes=32*1024*1024,private ttl=30000){}
 get(key:string){const value=this.entries.get(key);if(!value)return;if(value.expires<Date.now()){this.remove(key);return;}this.entries.delete(key);this.entries.set(key,value);return value;}
 put(key:string,body:Buffer,type:string){
  const value={body,type,etag:'"'+createHash('sha256').update(body).digest('hex')+'"',expires:Date.now()+this.ttl};
  if(body.length>this.maxBytes)return value;
  this.remove(key);while(this.bytes+body.length>this.maxBytes||this.entries.size>=256)this.remove(this.entries.keys().next().value!);
  this.entries.set(key,value);this.bytes+=body.length;return value;
 }
 private remove(key:string){const value=this.entries.get(key);if(value){this.bytes-=value.body.length;this.entries.delete(key);}}
}
