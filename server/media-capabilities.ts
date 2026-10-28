import {requireThat,type Doc} from './store.ts';
export const mediaKind=(mime:string)=>/^(image|video|audio)\//.exec(mime)?.[1];
export function validateVideoReferences(model:Doc,assets:Doc[],requested?:string){
 const image=assets.filter(a=>(a.mediaKind??'image')==='image'),video=assets.filter(a=>a.mediaKind==='video'),audio=assets.filter(a=>a.mediaKind==='audio');
 const mode=requested??(model.referenceMode==='first_frame'?'first_frame':model.referenceMode==='video_edit'?'video_edit':assets.length?'reference':'text');
 requireThat(['text','first_frame','first_last','reference','video_edit'].includes(mode),'视频参考模式无效',422);
 requireThat(!model.modes||model.modes.includes(mode),'此型号不支持该生成模式，请核对当前模型目录',422);
 requireThat(image.length>=(model.minReferences??0)&&image.length<=model.maxReferences,'此模型不支持当前参考图数量',422);
 requireThat(video.length>=(model.minVideoReferences??0)&&(model.maxVideoReferences===undefined?model.parameterPolicy==='provider':video.length<=model.maxVideoReferences)||video.length===0&&!(model.minVideoReferences??0),'此模型不支持当前参考视频数量',422);
 requireThat(audio.length===0||model.maxAudioReferences===undefined&&model.parameterPolicy==='provider'||audio.length<=model.maxAudioReferences,'此模型不支持当前参考音频数量',422);
 requireThat(!model.requiresReference||image.length+audio.length>0,'此型号需要参考图片或参考音频',422);
 if(mode==='first_frame')requireThat(image.length===1,'首帧模式需要一张图片',422);
 if(mode==='first_last')requireThat(image.length===2,'首尾帧模式需要按顺序提供两张图片',422);
 if(mode==='text')requireThat(!assets.length,'文生视频模式不能同时传参考媒体',422);
 if(mode==='video_edit')requireThat(video.length>0,'视频编辑需要参考视频',422);
 return mode;
}
