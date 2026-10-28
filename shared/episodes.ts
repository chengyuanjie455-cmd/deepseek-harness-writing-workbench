type Row=Record<string,any>;
export function episodeKey(value:unknown):string|undefined {
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return 'EP'+String(value).padStart(3,'0');
 if(typeof value!=='string')return;
 const text=value.normalize('NFC');
 const ep=/(?:^|[^a-z])(?:ep|episode)[ _-]*0*(\d{1,4})(?=$|[^a-z0-9])/i.exec(text);
 if(ep&&Number(ep[1])>0)return 'EP'+String(Number(ep[1])).padStart(3,'0');
 if(/\d+\s*[-~～至—]\s*\d+\s*集/.test(text))return;
 const cn=/第?\s*0*(\d{1,4})\s*集/.exec(text);
 if(cn&&Number(cn[1])>0)return 'EP'+String(Number(cn[1])).padStart(3,'0');
 const chinese=/第([一二三四五六七八九十百零〇两]+)集/.exec(text);
 if(chinese){const digit:Row={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,零:0,〇:0};let n=0,d=0;for(const c of chinese[1]){if(c==='十'||c==='百'){n+=(d||1)*(c==='十'?10:100);d=0;}else d=digit[c];}n+=d;if(n>0)return 'EP'+String(n).padStart(3,'0');}
}
export const episodeName=(id:string)=>id==='all'?'全部集数':id==='unassigned'?'公共 / 未分集':`第 ${Number(id.slice(2))} 集`;
