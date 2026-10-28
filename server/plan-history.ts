import {requireThat,type Doc} from './store.ts';
const key=(c:Doc)=>[String(c.plan.created??''),String(c.kind)+':'+String(c.plan.id)].join('|');
export function planPage(cards:Doc[],args:Doc={}){
 const limit=args.limit??30;requireThat(Number.isInteger(limit)&&limit>=1&&limit<=50,'每页数量须为 1–50');
 requireThat(!args.kind||['video','image'].includes(args.kind),'任务类型无效');let cursor:string|undefined;
 if(args.cursor!==undefined){requireThat(typeof args.cursor==='string'&&args.cursor.length<=1024&&/^[A-Za-z0-9_-]+$/.test(args.cursor),'历史游标无效');try{cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString());}catch{}requireThat(typeof cursor==='string','历史游标无效');}
 const all=cards.filter(c=>!args.kind||c.kind===args.kind).sort((a,b)=>key(a)<key(b)?1:key(a)>key(b)?-1:0);
 const remaining=all.filter(c=>!cursor||key(c)<cursor),items=remaining.slice(0,limit);
 return {kind:'plans',items,total:all.length,nextCursor:remaining.length>limit?Buffer.from(JSON.stringify(key(items.at(-1)!))).toString('base64url'):null};
}
