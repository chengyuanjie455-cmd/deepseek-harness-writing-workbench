import type {Store,Doc} from './store.ts';

const projectOf=(row:Doc)=>row.project??'shared';
export function sameScope(a:Doc,b:Doc){return a.owner===b.owner&&projectOf(a)===projectOf(b);}
export function nativeSessionFor(store:Store,row:Doc){
 if(row.nativeSession)return row.nativeSession;
 if(!row.session)return undefined;
 const session=store.get('session',row.session);
 if(session&&sameScope(session,row))return session.nativeSession??'session-team-'+session.id;
 return row.session?.startsWith('session-')?row.session:'session-team-'+row.session;
}
/** Shared ownership-checked links for task statistics and chat result cards. */
export function generationLinks(store:Store){
 const plans=[...store.all('pickup'),...store.all('image-plan')];
 const byPlan=new Map(plans.map(p=>[p.id,p]));
 const jobs:Doc[]=[...store.all('video-job').map(j=>({...j,kind:'video'})),...store.all('image-job').map(j=>({...j,kind:'image'}))];
 const audits:Doc[]=[];
 for(const row of store.db.prepare("SELECT actor,target,detail,created FROM audit WHERE action IN ('native.video.generate','native.image.generate') ORDER BY seq").all() as Doc[]){
  const plan=byPlan.get(row.target);const owner=plan??jobs.find(j=>(j.plan??j.planId??j.pickup)===row.target&&j.owner===row.actor);if(!owner||owner.owner!==row.actor)continue;
  try{const d=JSON.parse(row.detail);if(typeof d.session!=='string')continue;
   audits.push({owner:row.actor,project:projectOf(owner),planId:row.target,session:d.session,messageId:typeof d.sourceMessageId==='string'?d.sourceMessageId:undefined,prompt:typeof d.sourceText==='string'?d.sourceText:undefined,created:row.created});
  }catch{}
 }
 return {plans,jobs,audits,planFor:(job:Doc)=>{const plan=byPlan.get(job.plan??job.planId??job.pickup);return plan&&sameScope(plan,job)?plan:undefined;}};
}
