import {chooseNativeHostFolder} from './host-folder-bridge';
type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;

// The system picker is the only add-workspace UI. Reuse the existing import
// preview/digest contract so removing the form does not bypass validation.
export async function addWorkspaceFromNativeFolder(api:Api,signal:AbortSignal,choose=chooseNativeHostFolder){
 const selected=await choose('',signal);
 signal.throwIfAborted();
 if(!selected.supported)return {unsupported:true};
 if(!selected.path)return {cancelled:true};
 const path=selected.path,name=path.split(/[\\/]/).filter(Boolean).at(-1)??'';
 const preview=await api('/admin/projects/preview','POST',{path,name});
 signal.throwIfAborted();
 const project=await api('/admin/projects','POST',{previewId:preview.id,digest:preview.digest});
 signal.throwIfAborted();
 return {project:project.id};
}
