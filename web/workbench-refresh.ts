export type WorkbenchEventBatch={cursor:number;resetRequired?:boolean;events:{type:string;body?:Record<string,unknown>}[]};
const contentEvents=new Set(['project.updated','image.updated','pickup.confirmed','pickup.updated','assembly.updated']);
/** Invalidate the shared project read view from the same authorized host events
 * as the conversation. This never sends, retries or changes a chat operation. */
export function projectContentChanged(batch:WorkbenchEventBatch,project:string){
 return !!batch.resetRequired||batch.events.some(event=>contentEvents.has(event.type)&&(event.body?.project??'shared')===project);
}
type Options={
 readEvents:(after:number)=>Promise<WorkbenchEventBatch>;
 refresh:()=>Promise<void>;
 current:()=>boolean;
 cursor:{get:()=>number;set:(value:number)=>void};
 now?:()=>number;
 everyTick?:boolean;
 reconcileMs?:number;
};
/** This refreshes the outer read views only. Native chat streams, uploads,
 * editor state and generation submissions never pass through this scheduler. */
export class WorkbenchRefresh {
 private dirty=true;private refreshedAt=0;private flight?:Promise<WorkbenchEventBatch|undefined>;
 constructor(private options:Options){}
 poll(){
  if(this.flight)return this.flight;
  const work=this.read();this.flight=work;return work.finally(()=>{if(this.flight===work)this.flight=undefined;});
 }
 private async read(){
  const o=this.options,now=o.now??Date.now;
  try{
   if(!o.current())return;
   const result=await o.readEvents(o.cursor.get());if(!o.current())return;
   if(o.everyTick||this.dirty||result.resetRequired||result.events.length||now()-this.refreshedAt>=(o.reconcileMs??30000)){
    await o.refresh();if(!o.current())return;this.refreshedAt=now();this.dirty=false;
   }
   // A lost refresh must not acknowledge its events: retry the same cursor.
   o.cursor.set(result.resetRequired?0:result.cursor);return result;
  }catch(e){this.dirty=true;throw e;}
 }
}
