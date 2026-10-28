type ReadOptions<T>={read:()=>Promise<T>;commit:(value:T)=>void;fail:(error:unknown)=>void;busy?:(value:boolean)=>void};
/** A project query owns one read at a time. New events request a subsequent
 * reconciliation; they never discard a valid result of this same query. */
export class ProjectRead<T>{
 private flight?:Promise<void>;private dirty=false;private closed=false;private reading=false;
 constructor(private options:ReadOptions<T>){}
 refresh(){
  if(this.closed)return Promise.resolve();this.dirty=true;if(this.flight)return this.flight;
  if(!this.reading){this.reading=true;this.options.busy?.(true);}
  const work:Promise<void>=this.drain().finally(()=>{if(this.flight!==work)return;this.flight=undefined;if(this.closed)return;
   // A result callback may schedule the next event in a microtask between the
   // drain ending and this cleanup. Keep that invalidation rather than waiting
   // for an unrelated periodic poll to discover it.
   if(this.dirty)return this.refresh();this.reading=false;this.options.busy?.(false);
  });
  this.flight=work;return work;
 }
 private async drain(){
  while(this.dirty&&!this.closed){
   this.dirty=false;
   try{const value=await this.options.read();if(!this.closed)this.options.commit(value);}
   catch(error){if(!this.closed)this.options.fail(error);}
  }
 }
 close(){this.closed=true;this.dirty=false;}
}
