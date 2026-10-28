import {test} from 'node:test';import assert from 'node:assert/strict';import {parsePickup,modelMatches} from '../server/pickup-input.ts';
test('human template label after a model preserves model identity, multiline notes and validates alias duplicates',()=>{
 const p=parsePickup('剧本片段：汤勺捞起肉块\n补抽意见：只补抽本镜\n保留声音\n视频模型：小裴 Wan 3.0 竖屏参考图验收\n模板：重生80 单镜竖屏原片\n模型参数：画幅=9:16, 秒数=4');
 assert.equal(p.template,'重生80 单镜竖屏原片');assert.equal(p.notes,'只补抽本镜\n保留声音');assert.deepEqual(p.params,{aspect_ratio:'9:16',seconds:4});assert.equal(modelMatches(p.model,[{name:'小裴 Wan 3.0 竖屏参考图验收',aliases:[]}]).length,1);
 assert.throws(()=>parsePickup('提示词模板：甲\n模板：乙'),/同一字段/);
});
