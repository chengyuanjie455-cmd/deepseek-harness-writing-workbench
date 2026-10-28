import {FairQueue} from './fair-queue.ts';
// Provider capacity is independent from local upload/download/decoder pressure.
const queues={check:new FairQueue(4),upload:new FairQueue(8),download:new FairQueue(8),imageDownload:new FairQueue(8)};
function pool(key:keyof typeof queues){return async function<T>(run:()=>Promise<T>,signal?:AbortSignal):Promise<T>{const release=await queues[key].acquire('media',signal,key);try{signal?.throwIfAborted();return await run();}finally{release();}};}
export const withMediaCheck=pool('check');
export const withVideoUpload=pool('upload');
export const withVideoDownload=pool('download');
export const withImageDownload=pool('imageDownload');
export function mediaSlots(){return Object.fromEntries(Object.entries(queues).map(([k,q])=>[k,q.snapshot()]));}
