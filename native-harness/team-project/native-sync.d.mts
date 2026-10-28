export type NativeSyncPhase = 'waiting'|'loading'|'live'|'reconnecting'|'error';
export type NativeSyncSnapshot = {session:string|null;phase:NativeSyncPhase;observedAt:number;lastUpdateAt?:number};
export type NativeSyncToken = {session:string;serial:number};
export function createNativeSyncStatus(options:{emit:(value:NativeSyncSnapshot)=>void;now?:()=>number}):{
 begin(session:unknown):NativeSyncToken|undefined;
 update(token:NativeSyncToken|undefined,phase:'live'|'reconnecting'|'error'):void;
 end(token:NativeSyncToken|undefined):void;
 select(session:unknown):void;
 snapshot():void;
};
