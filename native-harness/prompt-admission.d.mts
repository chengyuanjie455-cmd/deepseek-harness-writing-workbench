export function installPromptAdmissionGuard(ctx:{sessionController?:{commands?:{prompt?:Function}};on:(name:string,listener:(...args:any[])=>void)=>(()=>void)|undefined}):()=>void;
