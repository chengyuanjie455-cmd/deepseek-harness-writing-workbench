import {requireThat,type Store} from './store.ts';
export const MAX_CONCURRENCY=500;
export const MAX_PENDING_TASKS=2000;
export function concurrencyValue(value:unknown){requireThat(Number.isInteger(value)&&Number(value)>=1&&Number(value)<=MAX_CONCURRENCY,`并发上限须为1至${MAX_CONCURRENCY}`);return Number(value);}

// Unverified channels start conservatively. Changing the configured ceiling alone
// must never silently assert a new tested capacity or interrupt existing work.
export function videoCapacity(store:Store,configured:number){
 const settings=store.get('runtime-concurrency','active');
 const testedVideo=concurrencyValue(settings?.testedVideo??1);
 return {testedVideo,effectiveVideo:Math.min(configured,testedVideo)};
}
export function channelCapacity(store:Store,channelId:string,fallback=1){
 const channel=store.get('video-channel',channelId),configured=channel?.concurrency??fallback;
 const evidence=store.get('runtime-concurrency','active')?.testedChannels?.[channelId];
 const registered=!!channel?.revision&&evidence?.revision===channel.revision;
 const tested=concurrencyValue(registered?evidence.limit:1);
 return {configured,tested,effective:Math.min(configured,tested),registered};
}

export const DEFAULT_IMAGE_CONCURRENCY=500;
export function imageCapacity(store:Store){return concurrencyValue(store.get('runtime-concurrency','active')?.image??DEFAULT_IMAGE_CONCURRENCY);}
/** Apply this release's requested capacity once; later administrator edits persist. */
export function migrateImageCapacity(store:Store){
 if(store.get('runtime','image-capacity-500-v1'))return;
 const previous=store.get('runtime-concurrency','active');
 store.tx(()=>{store.put('runtime-concurrency',{...previous,id:'active',image:DEFAULT_IMAGE_CONCURRENCY});store.put('runtime',{id:'image-capacity-500-v1',previous:previous?.image??2,image:DEFAULT_IMAGE_CONCURRENCY});});
}
