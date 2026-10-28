import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Doc} from './store.ts';
const run=promisify(execFile);
export function parseMacMemory(output:string){
 // This sysctl returns dispatch flags (1/2/4), not XNU's internal 0/1/2/3 enum.
 // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c
 const value=Number(output.match(/kern\.memorystatus_vm_pressure_level:\s*(\d+)/)?.[1]);
 const pressure=({1:'normal',2:'warning',4:'critical'} as Record<number,string>)[value]??'unknown';
 const swap=output.match(/vm\.swapusage:\s*total\s*=\s*([\d.]+)([KMG])\s+used\s*=\s*([\d.]+)([KMG])\s+free\s*=\s*([\d.]+)([KMG])/i);
 const bytes=(n:string,unit:string)=>Number(n)*1024**({K:1,M:2,G:3}[unit.toUpperCase()]!);
 return {memorySource:'macos',memoryPressure:pressure,swapTotalBytes:swap?bytes(swap[1],swap[2]):null,swapUsedBytes:swap?bytes(swap[3],swap[4]):null,swapFreeBytes:swap?bytes(swap[5],swap[6]):null};
}
export class MemorySampler{
 private sampled:Doc={memorySource:'macos',memoryPressure:'unknown',memoryProbe:'pending'};
 private at=0;private attempt=0;private pending?:Promise<void>;
 constructor(private probe=async()=>{const {stdout}=await run('/usr/sbin/sysctl',['kern.memorystatus_vm_pressure_level','vm.swapusage'],{timeout:1500,maxBuffer:8192});return stdout;},private clock=Date.now){}
 refresh(){if(this.pending)return this.pending;this.attempt=this.clock();this.pending=(async()=>{try{const data=parseMacMemory(await this.probe());this.at=this.clock();this.sampled={...data,memoryProbe:data.memoryPressure==='unknown'?'unavailable':'ready',memorySampledAt:new Date(this.at).toISOString()};}catch{this.at=0;this.sampled={memorySource:'macos',memoryPressure:'unknown',memoryProbe:'unavailable'};}})().finally(()=>{this.pending=undefined;});return this.pending;}
 snapshot(){if(!this.attempt||this.clock()-this.attempt>=30000)void this.refresh();return this.at&&this.clock()-this.at>90000?{...this.sampled,memoryPressure:'unknown',memoryProbe:'stale'}:this.sampled;}
}
const sampler=new MemorySampler();
export const memorySnapshot=()=>process.platform==='darwin'?sampler.snapshot():{memorySource:'free-ratio'};
export const refreshMemorySnapshot=()=>process.platform==='darwin'?sampler.refresh():Promise.resolve();
