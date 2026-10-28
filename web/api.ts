export class StaleResponse extends Error {}
export const desktopTransport: typeof fetch = async (input, init) => {
  if (typeof window === 'undefined' || !window.teamDesktop) return fetch(input, init);
  const signal = init?.signal; signal?.throwIfAborted();
  const result = await new Promise<any>((resolve, reject) => {
    const abort = () => reject(new Error('请求超时或登录状态已变更'));
    signal?.addEventListener('abort', abort, {once:true});
    window.teamDesktop!.request(String(input), init?.method ?? 'GET', typeof init?.body === 'string' ? JSON.parse(init.body) : undefined)
      .then(resolve,reject).finally(() => signal?.removeEventListener('abort',abort));
  });
  if (!result.ok) throw new Error(result.error || '连接中断');
  return new Response(JSON.stringify(result.value.data), { status: result.value.status, headers: {'Content-Type':'application/json'} });
};

// One lifetime per signed-in identity. A response from an earlier identity must
// never update either UI state or the current CSRF token.
export class ApiClient {
  csrf = '';
  projectId='shared';
  selectProject(projectId:string){this.invalidate();this.projectId=projectId;}
  private lifetime = new AbortController();
  constructor(private transport: typeof fetch = desktopTransport, private timeoutMs = 15000) {}
  invalidate() { this.lifetime.abort(); this.lifetime = new AbortController(); }
  async call(path: string, method = 'GET', body?: unknown): Promise<any> {
    const lifetime = this.lifetime;
    if(this.projectId!=='shared'&&!new URL(path,'http://local').searchParams.has('project'))path+=(path.includes('?')?'&':'?')+'project='+encodeURIComponent(this.projectId);
    try {
      const response = await this.transport(`${typeof location!=='undefined'?(location.pathname.match(/^\/harness\/[^/]+\/team-settings/)?.[0]??''):''}/api${path}`, {
        method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(path.startsWith('/native/open')?120000:this.timeoutMs)]),
      });
      const result = await response.json();
      if (lifetime !== this.lifetime) throw new StaleResponse();
      if (!response.ok) throw Object.assign(new Error(result.error || '请求失败'), { status: response.status });
      if (result?.csrf) this.csrf = result.csrf;
      return result;
    } catch (error: any) {
      if (lifetime !== this.lifetime || error instanceof StaleResponse) throw new StaleResponse();
      if (error.status) throw error;
      throw Object.assign(new Error(method === 'GET' ? '连接暂时中断，正在重新连接…' : '暂未收到服务器确认，请先核对提交状态。'), { uncertain: true });
    }
  }
}
