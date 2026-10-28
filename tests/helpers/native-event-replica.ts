import WebSocket from 'ws';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';

type Row=Record<string,any>;
const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const eventDigest=(value:any)=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
async function until(check:()=>boolean,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await delay(20);}throw Error('native event subscription timed out');}

/** Protocol test client for the pinned native RC.2 session/follow stream.
 * Reads real events; never sends prompts, model requests or generation work. */
export class NativeEventReplica{
 socket?:WebSocket;streams=new Map<string,Row>();journals=new Map<string,Row>();errors:Row[]=[];
 closed=false;intentional=false;closeCode?:number;
 constructor(public url:string,private cookie:string,public name:string){}
 async connect(sessions:string[]){
  assert.equal(this.socket,undefined,'create a fresh receiver for each physical connection');
  const target=new URL('/harness/shared/api/remote.mux',this.url);target.protocol=target.protocol==='https:'?'wss:':'ws:';
  this.socket=new WebSocket(target,{headers:{Origin:this.url,Cookie:this.cookie}});
  this.socket.on('message',bytes=>{try{this.receive(JSON.parse(bytes.toString()));}catch(error:any){this.errors.push({message:error.message});}});
  this.socket.on('close',code=>{this.closed=true;this.closeCode=code;});
  this.socket.on('error',error=>{if(!this.intentional)this.errors.push({socket:error.message});});
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{this.socket!.terminate();reject(Error('native websocket open timed out'));},15000);
   this.socket!.once('open',()=>{clearTimeout(timer);resolve();});this.socket!.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  await Promise.all(sessions.map(session=>this.follow(session)));return this;
 }
 private receive(frame:Row){
  const stream=this.streams.get(frame.streamId);assert(stream,'unexpected logical stream');
  if(frame.type==='error'){stream.error={code:frame.error?.code,message:frame.error?.message};if(!stream.allowError)this.errors.push(stream.error);return;}
  if(frame.type==='end'){stream.ended=true;return;}
  assert.equal(frame.type,'item');const value=frame.value;stream.items++;
  if(value.type==='snapshot'){
   assert.equal(value.header.id,stream.session);stream.snapshot=true;stream.opening=value;
   stream.revision=value.assistantStream?.revision??0;stream.active=value.assistantStream?.activeAttempt?.attemptId;
   stream.index=value.assistantStream?.activeAttempt?.nextIndex??0;
   stream.events=new Map((value.records??[]).map((record:Row)=>[record.event.seq,record.event]));stream.snapshotCount++;return;
  }
  if(value.type==='event'){
   const previous=stream.events.get(value.event.seq);if(previous)assert.equal(eventDigest(previous),eventDigest(value.event),'durable event changed');
   stream.events.set(value.event.seq,value.event);stream.eventFrames++;return;
  }
  assert.equal(value.type,'assistant-stream');const assistant=value.frame;
  assert.equal(assistant.revision,stream.revision+1,'assistant revision gap');
  if(assistant.type==='start'){stream.active=assistant.attemptId;stream.index=0;}
  else{
   assert.equal(assistant.attemptId,stream.active,'attempt changed without baseline');assert.equal(assistant.index,stream.index,'assistant chunk gap');
   if(assistant.type==='chunk')stream.index++;else{assert.equal(assistant.type,'end');stream.active=undefined;}
  }
  stream.revision=assistant.revision;stream.assistantFrames++;
 }
 async follow(session:string,allowError=false){
  const streamId=randomUUID(),stream:Row={session,allowError,items:0,events:new Map(),revision:0,index:0,snapshot:false,snapshotCount:0,eventFrames:0,assistantFrames:0};
  this.streams.set(streamId,stream);if(!allowError)this.journals.set(session,stream);
  assert.equal(this.socket?.readyState,WebSocket.OPEN);
  this.socket.send(JSON.stringify({type:'open',streamId,endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId:session},assistantStream:true,maxMessages:200}}}}));
  await until(()=>stream.snapshot||!!stream.error||this.closed);assert(!this.closed,'native socket closed before subscription baseline');return stream;
 }
 messages(session:string){return [...(this.journals.get(session)?.events.values()??[])].filter((event:Row)=>event.type==='assistant/message'||event.type==='user/message'&&event.data?.source?.kind==='user').sort((a:Row,b:Row)=>a.seq-b.seq);}
 recentDigest(session:string,count=4){return eventDigest(this.messages(session).slice(-count));}
 async drop(){this.intentional=true;if(!this.socket||this.socket.readyState===WebSocket.CLOSED)return;this.socket.terminate();await until(()=>this.closed);}
 summary(){return {name:this.name,closed:this.closed,closeCode:this.closeCode,errors:this.errors,
  journals:[...this.journals.values()].map(stream=>({session:stream.session,snapshotCount:stream.snapshotCount,eventFrames:stream.eventFrames,
   assistantFrames:stream.assistantFrames,activeOpening:!!stream.opening?.assistantStream?.activeAttempt,
   openingPartialChunks:stream.opening?.assistantStream?.activeAttempt?.stream?.length??0,events:stream.events.size,
   recentMessageDigest:this.recentDigest(stream.session)}))};}
}
