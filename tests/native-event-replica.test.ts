import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer,WebSocket} from 'ws';
import {NativeEventReplica} from './helpers/native-event-replica.ts';

test('native event receiver follows real logical streams and detects changed journals and chunk gaps',async()=>{
 const server=createServer(),sockets=new WebSocketServer({server}),opened:any[]=[];
 let remote:WebSocket|undefined,streamId='';
 const event={seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'synthetic original'}]}};
 sockets.on('connection',socket=>{remote=socket;socket.on('message',bytes=>{
  const frame=JSON.parse(bytes.toString());opened.push(frame);const session=frame.payload.args.request.address.sessionId;
  if(session==='foreign'){socket.send(JSON.stringify({type:'error',streamId:frame.streamId,error:{code:'not-found',message:'private session'}}));return;}
  streamId=frame.streamId;socket.send(JSON.stringify({type:'item',streamId,value:{type:'snapshot',header:{id:session},records:[{event}],assistantStream:{revision:0}}}));
 });});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const replica=new NativeEventReplica('http://127.0.0.1:'+(server.address() as any).port,'synthetic-cookie','receiver-test');
 try{
  await replica.connect(['own']);assert.equal(opened[0].endpoint,'session/follow');assert.equal(opened[0].payload.args.request.assistantStream,true);
  const send=(value:any)=>remote!.send(JSON.stringify({type:'item',streamId,value}));
  send({type:'assistant-stream',frame:{type:'start',revision:1,attemptId:'a'}});
  send({type:'assistant-stream',frame:{type:'chunk',revision:2,attemptId:'a',index:0,chunk:{content:'synthetic'}}});
  send({type:'assistant-stream',frame:{type:'end',revision:3,attemptId:'a',index:1}});
  send({type:'event',event});
  for(let n=0;n<100&&replica.journals.get('own')!.assistantFrames<3;n++)await delay(10);
  assert.equal(replica.journals.get('own')!.assistantFrames,3);assert.equal(replica.messages('own').length,1);assert.equal(replica.errors.length,0);
  const denied=await replica.follow('foreign',true);assert.equal(denied.error.code,'not-found');assert.equal(replica.errors.length,0);
  send({type:'event',event:{...event,data:{...event.data,content:[{type:'text',text:'changed original'}]}}});
  send({type:'assistant-stream',frame:{type:'start',revision:5,attemptId:'b'}});
  for(let n=0;n<100&&replica.errors.length<2;n++)await delay(10);
  assert.equal(replica.errors.length,2);assert(replica.errors.some(error=>error.message.includes('durable event changed')));assert(replica.errors.some(error=>error.message.includes('assistant revision gap')));
  assert.equal(replica.messages('own')[0].data.content[0].text,'synthetic original');
 }finally{await replica.drop();await new Promise<void>(resolve=>sockets.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
