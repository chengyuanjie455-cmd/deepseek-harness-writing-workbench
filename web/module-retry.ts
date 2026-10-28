type Manifest=Record<string,{file:string;imports?:string[];css?:string[]}>;
type Dependencies={base:string;entry?:string;manifest:()=>Promise<Manifest>;css:(urls:string[])=>Promise<void>;importer:(url:string)=>Promise<unknown>;nonce:()=>string};
function asset(file:string,base:string,extension:string){
  if(!new RegExp('^assets/[A-Za-z0-9_.-]+\\.'+extension+'$').test(file))throw Error('界面模块地址无效');
  const url=new URL('/'+file,base),origin=new URL(base).origin;
  if(url.origin!==origin||url.username||url.password)throw Error('界面模块来源无效');
  return url.href;
}
export function moduleRetryPlan(manifest:Manifest,key:string,base:string,expectedEntry?:string){
  if(expectedEntry&&(!manifest['index.html']||asset(manifest['index.html'].file,base,'js')!==new URL(expectedEntry,base).href))throw Error('界面版本已经变化，原内容保留，请保存草稿后重新打开');
  const entry=manifest[key];if(!entry)throw Error('当前版本缺少此界面模块');
  const seen=new Set<string>(),css=new Set<string>();
  function visit(k:string){if(seen.has(k))return;seen.add(k);const value=manifest[k];if(!value)throw Error('界面模块清单不完整');for(const dependency of value.imports??[])visit(dependency);for(const file of value.css??[])css.add(asset(file,base,'css'));}
  visit(key);return {module:asset(entry.file,base,'js'),css:[...css]};
}
function loadCSS(urls:string[]){return Promise.all(urls.map(url=>new Promise<void>((resolve,reject)=>{
  if(Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).some(l=>l.href===url&&l.sheet)){resolve();return;}
  const link=document.createElement('link'),timer=setTimeout(()=>{link.remove();reject(Error('样式加载超时'));},15000);link.rel='stylesheet';link.href=url;
  link.onload=()=>{clearTimeout(timer);resolve();};link.onerror=()=>{clearTimeout(timer);link.remove();reject(Error('样式暂未加载'));};document.head.append(link);
}))).then(()=>{});}
export function recoverableModule<M>(initial:()=>Promise<M>,key:string,dependencies?:Dependencies,select?:(value:unknown)=>M){
  return async(attempt=0):Promise<M>=>{
    if(!attempt)return initial();
    const d=dependencies??{base:document.baseURI,entry:document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src,manifest:async()=>{const response=await fetch(new URL('/ui-module-map.json',document.baseURI),{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('界面版本清单暂未加载');return response.json();},css:loadCSS,importer:(url:string)=>import(/* @vite-ignore */ url),nonce:()=>String(Date.now())};
    const plan=moduleRetryPlan(await d.manifest(),key,d.base,d.entry);await d.css(plan.css);
    const url=new URL(plan.module);url.searchParams.set('wawu_module_retry',attempt+'-'+d.nonce());const loaded=await d.importer(url.href);return select?select(loaded):loaded as M;
  };
}
