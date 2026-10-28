import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {forwardNativeRequest} from '../server/native-harness.ts';
test('native prompt retries one lost receipt with the identical request ID; ordinary writes are never replayed',async()=>{
 let attempts=0;const accepted=new Set<string>(),bodies:string[]=[];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;attempts++;bodies.push(body);const id=JSON.parse(body).payload?.args?.request?.requestId;if(id)accepted.add(id);if(attempts===1){res.destroy();return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({accepted:true}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+(server.address() as any).port;const body=JSON.stringify({method:'session/prompt',payload:{args:{request:{sessionId:'native-test',requestId:'same-durable-id',content:[{type:'text',text:'once'}]}}}});let retries=0;
 try{const response=await forwardNativeRequest(base+'/api/session/prompt',{method:'POST',body},()=>retries++);assert.equal(response.status,200);await response.text();assert.equal(attempts,2);assert.equal(retries,1);assert.equal(accepted.size,1);assert.equal(bodies[0],bodies[1]);
 attempts=0;await assert.rejects(forwardNativeRequest(base+'/api/workspace/write',{method:'POST',body}));assert.equal(attempts,1);
 attempts=0;await assert.rejects(forwardNativeRequest(base+'/api/session/prompt',{method:'POST',body:JSON.stringify({method:'session/prompt',payload:{args:{request:{sessionId:'native-test'}}}})}));assert.equal(attempts,1);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
