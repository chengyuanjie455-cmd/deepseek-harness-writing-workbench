export const teamDefinitions: [string,string,string,Record<string,unknown>,string[]?][];
export const teamInstructions:string;
export function generationContext(value:any):string;
export function failureEvents(session:any,events:any[],inherited?:number):any[];
export function registerGenerationContext(ctx:any,config:any):void;
export function apply(ctx:any,config:any):Promise<void>;

export function projectSourceContext(value:any):string;
export function registerProjectSourceContext(ctx:any,config:any):void;

export function teamToolDefinitions(config?:Record<string,unknown>):typeof teamDefinitions;
