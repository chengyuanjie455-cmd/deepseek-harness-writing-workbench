import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';

type Packet = Record<string, any>;
type Options = {command:string; args?:string[]; cwd:string; home:string};

/** Host-owned stdio transport. Never attaches to or shuts down a user's desktop process.
 * Uses the same initialize/thread/turn protocol as the existing HAPI client.
 */
export class CodexClient {
  private child?:ChildProcessWithoutNullStreams;
  private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private sequence=0;
  private stopped=false;
  onEvent:(method:string,params:Packet)=>void=()=>{};
  onRequest:(method:string,params:Packet)=>Promise<unknown>=async()=>{throw Error('不支持此交互请求');};
  onDisconnect:(error:Error)=>void=()=>{};
  constructor(private options:Options){}
  async connect(){
    if(this.child)throw Error('Codex transport already started');
    const env:NodeJS.ProcessEnv={...process.env,CODEX_HOME:this.options.home};
    delete env.HAPI_SESSION_ID;delete env.CODEX_THREAD_ID;
    this.child=spawn(this.options.command,this.options.args??['app-server','--listen','stdio://'],{cwd:this.options.cwd,env,stdio:['pipe','pipe','pipe']});
    const lines=createInterface({input:this.child.stdout});
    lines.on('line',line=>{
      if(line.length>8*1024*1024)return this.fail(Error('Codex 单个事件过大'));
      let p:Packet;try{p=JSON.parse(line);}catch{return this.fail(Error('Codex 事件格式无效'));}
      if(typeof p.method==='string'){
        if(p.id!==undefined)void this.onRequest(p.method,p.params??{}).then(result=>this.send({id:p.id,result}),error=>this.send({id:p.id,error:{code:-32000,message:error instanceof Error?error.message:'工具调用失败'}})).catch(()=>{});
        else try{this.onEvent(p.method,p.params??{});}catch(error){this.fail(error instanceof Error?error:Error('事件写入失败'));}
      }else if(typeof p.id==='number'){
        const request=this.pending.get(p.id);if(!request)return;
        this.pending.delete(p.id);clearTimeout(request.timer);
        if(p.error)request.reject(Error(p.error.message??'Codex 请求失败'));else request.resolve(p.result);
      }
    });
    this.child.stderr.resume(); // Never forward raw CLI diagnostics or credential material to members.
    this.child.stdin.on('error',()=>this.fail(Error('Codex 输入连接中断')));
    this.child.once('error',()=>this.fail(Error('无法启动主机 Codex，请核对可执行文件')));
    this.child.once('close',()=>{lines.close();this.fail(Error('Codex 连接中断；未自动重发任务'));});
    await this.request('initialize',{clientInfo:{name:'wawu-host',version:'2026.10.03'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized',params:{}});
  }
  request(method:string,params:unknown={},timeout=30_000):Promise<any>{
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Codex 请求超时：'+method+'；结果待核对，未自动重发'));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      try{this.send({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  private send(packet:Packet){if(this.stopped||!this.child?.stdin.writable)throw Error('Codex 连接已关闭');this.child.stdin.write(JSON.stringify(packet)+'\n');}
  private fail(error:Error){if(this.stopped)return;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.onDisconnect(error);}
  async close(){
    if(this.stopped)return;this.stopped=true;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Codex 连接已停止'));}this.pending.clear();
    const child=this.child;if(!child||child.exitCode!==null||child.signalCode!==null)return;
    await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),2500);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
  }
}
