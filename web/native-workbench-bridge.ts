export function acceptsProjectFiles(event:{source:unknown;origin:string;data:any},view:{source:unknown;url:string;scope:string;version:number;project:string;visible:boolean}){
 const data=event.data;
 return view.visible&&!!view.source&&event.source===view.source&&event.origin===new URL(view.url).origin&&data?.scope===view.scope&&data.type==='team-workbench-panel'&&data.protocolVersion===1&&data.version===view.version&&data.project===view.project&&data.section==='files';
}
