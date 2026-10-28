import React,{useEffect,useState} from 'react';
type Item=Record<string,any>;type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;
export function RemoveModelButton({model,kind,busy,remove}:{model:Item,kind:string,busy:boolean,remove:()=>void}){
 const [confirm,setConfirm]=useState(false);
 return confirm?<span role="group" aria-label={`删除${model.name}`}><span className="small">停止新提交，保留原任务及结果？</span><button disabled={busy} onClick={remove}>确认删除{kind==='image'?'图片':'视频'}模型</button><button disabled={busy} onClick={()=>setConfirm(false)}>取消</button></span>:<button disabled={busy} onClick={()=>setConfirm(true)}>删除</button>;
}
const initial={name:'',aliases:[] as string[],channelId:'',remoteModel:'',imageRoute:'multipart-edits',maxReferences:0,capabilityEvidence:'',status:'disabled'};
const initialParams={resolution:['1k'],aspect_ratio:['1:1']},initialDefaults={resolution:'1k',aspect_ratio:'1:1'};
export function ImageModelAdmin({api,channels,refreshKey}:{api:Api,channels:Item[],refreshKey:number}){
 const [models,setModels]=useState<Item[]>([]),[model,setModel]=useState<Item>(initial),[query,setQuery]=useState(''),[params,setParams]=useState(JSON.stringify(initialParams,null,2)),[defaults,setDefaults]=useState(JSON.stringify(initialDefaults,null,2)),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 async function load(){setModels((await api('/admin/media-models')).filter((m:Item)=>m.kind==='image'));}
 useEffect(()=>{void load().catch(e=>setError(e.message));},[refreshKey]);
 function edit(m?:Item){setModel(m?Object.fromEntries(['id',...Object.keys(initial)].map(k=>[k,m[k]??initial[k as keyof typeof initial]])):initial);setParams(JSON.stringify(m?.params??initialParams,null,2));setDefaults(JSON.stringify(m?.defaults??initialDefaults,null,2));setNotice('');}
 async function act(fn:()=>Promise<void>){if(busy)return;setBusy(true);setError('');setNotice('');try{await fn();await load();setNotice('图片模型已保存并回读。');}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 const field=(key:string,label:string,type='text')=><label>{label}<input required type={type} value={model[key]??''} onChange={e=>setModel({...model,[key]:type==='number'?Number(e.target.value):e.target.value})}/></label>;
 return <div className="card admin-card" aria-label="图片模型管理"><h3>可用图片模型</h3><p className="small muted">新增和开放前，核对该账号型号、接口与参数。只支持下列已实现协议。删除后停止新提交；原任务和原图保留，同步目录不会自动恢复。</p>{error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status" className="notice">{notice}</p>}<label>搜索图片模型<input value={query} onChange={e=>setQuery(e.target.value)}/></label>
 <div style={{maxHeight:320,overflowY:'auto'}}>{models.filter(m=>(m.name+' '+m.remoteModel).toLowerCase().includes(query.toLowerCase())).map(m=><div className="video-config-row" key={m.id}><b>{m.name}</b><small>{m.channelName} · {m.status==='available'?'已开放，未逐型号实测':'已停用'}</small><button disabled={busy} onClick={()=>edit(m)}>编辑</button><RemoveModelButton model={m} kind="image" busy={busy} remove={()=>void act(async()=>{await api(`/admin/media-models/image/${m.id}/remove`,'POST',{});if(model.id===m.id)edit();})}/></div>)}</div>
 <form onSubmit={e=>{e.preventDefault();void act(async()=>{const saved=await api('/admin/image-models','POST',{...model,params:JSON.parse(params),defaults:JSON.parse(defaults)});edit(saved);});}}>
 {field('name','图片模型展示名称')}{field('remoteModel','图片 API 真实模型 ID')}
 <label>图片所属渠道<select aria-label="图片所属渠道" required value={model.channelId} onChange={e=>setModel({...model,channelId:e.target.value})}><option value="">选择已验证的小裴渠道</option>{channels.filter(c=>c.adapter==='xiaopei'&&c.enabled&&c.verified).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
 <label>图片模型别名（逗号分隔）<input value={model.aliases.join(',')} onChange={e=>setModel({...model,aliases:e.target.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)})}/></label>
 <label>图片协议<select aria-label="图片协议" value={model.imageRoute} onChange={e=>setModel({...model,imageRoute:e.target.value})}><option value="multipart-edits">GPT：generations / multipart edits</option><option value="url-generations">URL generations：豆姐／香蕉等</option><option value="url-edits">URL edits：稳定 4k 等</option></select></label>
 <label>图片允许参数（JSON）<textarea rows={4} value={params} onChange={e=>setParams(e.target.value)}/></label><label>图片默认参数（JSON）<textarea rows={3} value={defaults} onChange={e=>setDefaults(e.target.value)}/></label>{field('maxReferences','图片参考原图上限','number')}
 <label>图片协议核对依据<textarea required value={model.capabilityEvidence} onChange={e=>setModel({...model,capabilityEvidence:e.target.value})}/></label>
 <label>图片模型状态<select aria-label="图片模型状态" value={model.status} onChange={e=>setModel({...model,status:e.target.value})}><option value="disabled">停用</option><option value="available">向成员开放（保留未实测标记）</option></select></label>
 <button className="primary" disabled={busy}>保存图片模型</button><button type="button" disabled={busy} onClick={()=>edit()}>新增图片模型</button></form></div>;
}
