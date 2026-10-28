import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readModelJSON} from './helpers/model-json.ts';

test('model fixture preserves Chinese context and tool arguments across arbitrary byte boundaries',async()=>{
 const body={messages:[{role:'user',content:'主角陈山，画左 → 画右，🙂保留前文。'},{role:'tool',content:JSON.stringify({notes:'修改对白：“我不要走！”',path:'参考图/陈山.png'})}],tools:[{function:{name:'team_video_generate'}}]};
 const bytes=Buffer.from(JSON.stringify(body));
 for(const size of [1,2,7,16384]){
  async function* chunks(){for(let i=0;i<bytes.length;i+=size)yield bytes.subarray(i,i+size);}
  assert.deepEqual(await readModelJSON(chunks()),body,'chunk size '+size);
 }
 async function* invalid(){yield Buffer.from('{invalid');}
 await assert.rejects(readModelJSON(invalid()),SyntaxError);
});
