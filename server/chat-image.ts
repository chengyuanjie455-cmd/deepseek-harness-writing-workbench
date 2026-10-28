import {requireThat,type Doc} from './store.ts';
/** Image-producing chat routes emit fragmented SSE, never a second paid POST. */
export function chatImagePayload(model:Doc,prompt:string,images:string[]=[]){return {model:model.remoteModel,messages:[{role:'user',content:[...images.map(url=>({type:'image_url',image_url:{url}})),{type:'text',text:prompt}]}],stream:true};}
export function chatImageReceipt(raw:string,origin:string):Doc {
 let content='',usage:Doc|undefined,error:Doc|undefined;const candidates:string[]=[];
 const collect=(part:any)=>{if(typeof part==='string')content+=part;else if(Array.isArray(part))for(const p of part){if(p.type==='text')collect(p.text);else if(p.type==='image_url'&&p.image_url?.url)candidates.push(p.image_url.url);} };
 const consume=(v:Doc)=>{if(v.error)error=v.error;if(v.usage)usage=v.usage;for(const c of v.choices??[]){const d=c.delta??c.message??{};collect(d.content);for(const image of d.images??[])if(image.image_url?.url)candidates.push(image.image_url.url);}for(const i of v.data??[])if(i.url)candidates.push(i.url);else if(i.b64_json)candidates.push('data:image/png;base64,'+i.b64_json);};
 if(raw.trim().startsWith('{'))consume(JSON.parse(raw));
 else {let done=false;for(const event of raw.replace(/\r\n/g,'\n').split('\n\n')){const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]'){if(data==='[DONE]')done=true;continue;}consume(JSON.parse(data));}requireThat(done,'图片流中断，保留原请求待核对，不自动再次生成',502);}
 requireThat(!error,String(error?.message??'图片接口错误'),502);
 for(const m of content.matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g))candidates.push(m[1]);
 for(const m of content.matchAll(/data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*/g))candidates.push(m[0]);
 if(!candidates.length){const direct=content.trim();if(/^https:\/\/\S+\.(?:png|jpg|jpeg|webp)(?:\?\S*)?$/i.test(direct))candidates.push(direct);}
 requireThat(candidates.length>0,'图片接口未返回原图，保留原请求待核对',502);const url=candidates[0];
 if(url.startsWith('data:'))return {data:[{b64_json:url.slice(url.indexOf(',')+1)}],...(usage?{usage}:{}),responseType:'chat-image'};
 const result=new URL(url,url.startsWith('/')?new URL(origin).origin:origin+'/');requireThat(result.protocol==='https:'&&!result.username&&!result.password,'图片接口返回的原图地址无效',502);
 return {data:[{url:result.href}],...(usage?{usage}:{}),responseType:'chat-image'};
}
