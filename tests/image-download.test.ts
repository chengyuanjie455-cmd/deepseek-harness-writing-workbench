import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,get} from 'node:http';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {originalImageStream} from '../server/image-generation.ts';
async function collect(stream:Readable){const parts:Buffer[]=[];for await(const part of stream)parts.push(Buffer.from(part));return Buffer.concat(parts);}
test('HTTP image keeps its PNG header and every byte when the saving consumer attaches late',async()=>{
 const body=Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d494844520000080000000800','hex'),Buffer.alloc(300000,37)]);
 const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Length':body.length,'Content-Type':'image/png'});res.end(body);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const stream=await new Promise<Readable>((resolve,reject)=>{get('http://127.0.0.1:'+(server.address() as any).port,res=>resolve(originalImageStream(res,Number(res.headers['content-length'])))).on('error',reject);});
  await delay(50);assert.deepEqual(await collect(stream),body);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('truncated responses and oversize streams fail with byte counts; slow consumers do not lose data',async()=>{
 await assert.rejects(collect(originalImageStream(Readable.from([Buffer.alloc(10)]),20)),(e:any)=>e.downloadBytes===10&&e.downloadExpectedBytes===20&&/不完整/.test(e.message));
 await assert.rejects(collect(originalImageStream(Readable.from([Buffer.alloc(11)]),undefined,10)),(e:any)=>e.downloadBytes===11&&/上限/.test(e.message));
 const source=Readable.from([Buffer.alloc(12)]),stream=originalImageStream(source,12);source.destroy(Object.assign(Error('test connection reset'),{code:'ECONNRESET'}));await delay(10);
 await assert.rejects(collect(stream),(e:any)=>e.code==='ECONNRESET'&&e.downloadBytes===0);
});
test('abandoning a download closes the source without draining bytes',async()=>{
 const source=new Readable({read(){}}),stream=originalImageStream(source);stream.destroy();await delay(5);assert(source.destroyed);
});
