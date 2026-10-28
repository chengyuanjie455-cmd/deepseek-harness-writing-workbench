type Request={protocolVersion:number;version:number;project:string;session:string;requestId:string;text:string};
type Receipt={type:string;protocolVersion:number;version:number;requestId:string;session:string;project:string;state:string;error?:string};
export function createNativeReferenceBridge(options:{scope:string;project:string;storage?:{getItem(key:string):string|null;setItem(key:string,value:string):void};currentSession():string|undefined;insert(session:string,text:string):boolean|Promise<boolean>}):{receive(request:Request):Promise<Receipt>};
