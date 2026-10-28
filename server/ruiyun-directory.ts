import {requireThat,type Doc} from './store.ts';

/** Endpoint labels alone are ambiguous: Ruiyun also labels some media as openai. */
export function ruiyunKind(row:Doc):'chat'|'image'|'video'|undefined {
  const tags=String(row.tags??''),endpoints=row.supported_endpoint_types??[];
  if(/(?:^|[,，])LLM(?:$|[,，])/i.test(tags))return 'chat';
  if(tags.includes('图片生成')||endpoints.includes('image-generation'))return 'image';
  if(tags.includes('视频生成')||endpoints.includes('openai-video'))return 'video';
  // Auxiliary token-priced models expose a chat-compatible endpoint, not a
  // video/image creation contract. Keep their exact response in native chat.
  if(tags.includes('其他')&&tags.includes('按Token计费')&&endpoints.includes('openai'))return 'chat';
}
export async function ruiyunPricing(origin:string,fetcher:typeof fetch=fetch){
  const response=await fetcher(origin.replace(/\/$/,'')+'/api/pricing',{redirect:'error',signal:AbortSignal.timeout(20000)});
  requireThat(response.ok,'瑞云分类目录获取失败（HTTP '+response.status+'）',502);
  const raw=await response.text();requireThat(raw.length<=2*1024*1024,'瑞云分类目录过大',502);
  let body:Doc;try{body=JSON.parse(raw);}catch{throw new Error('瑞云分类目录不是有效 JSON');}
  requireThat(body.success===true&&Array.isArray(body.data)&&body.data.length<=2000,'瑞云分类目录格式无效',502);
  return body;
}
