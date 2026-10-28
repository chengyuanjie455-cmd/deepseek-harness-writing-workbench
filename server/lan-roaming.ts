import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { isIPv4 } from 'node:net';
import { advertise } from './discovery.ts';

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;
export function lanAddresses(interfaces: Interfaces): string[] {
  const result = new Set<string>();
  for (const name of Object.keys(interfaces).sort()) {
    // Physical Ethernet/Wi-Fi only; never expose the service on VPN, bridge or public interfaces.
    if (!/^(?:en\d+|eth\d+|wlan\d+|en[opsx][\w.-]+|wl[px][\w.-]+|Wi-Fi(?: \d+)?|Ethernet(?: \d+)?)$/.test(name)) continue;
    for (const nic of interfaces[name] ?? []) {
      const [a,b] = nic.address.split('.').map(Number);
      if (!nic.internal && isIPv4(nic.address) && (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168)) result.add(nic.address);
    }
  }
  return [...result];
}
type Target = { serverId: string; addLanListener(bind:string,port:number): Promise<number>; removeLanListener(bind:string,port:number): Promise<void> };
export type LanState = { automatic: true; urls: string[]; memberUrl: string | null; discoveryUrl: string | null; errors: { address:string; code:string }[] };
type Options = {
  interfaces?: () => Interfaces; advertise?: typeof advertise;
  memberHostname?: string | null;
  changed: (state:LanState) => void; failed?: () => void; intervalMs?: number;
};
export class LanRoaming {
  private listeners = new Map<string,number>();
  private pending?: Promise<void>; private timer?: ReturnType<typeof setInterval>; private stopped = false;
  private announcements = new Map<string,()=>void>(); private last = '';
  constructor(private target:Target, private port:number, private options:Options) {}
  async start() {
    await this.refresh();
    this.timer=setInterval(()=>{void this.refresh().catch(()=>this.options.failed?.());},this.options.intervalMs ?? 5000);
    this.timer.unref();
  }
  refresh(): Promise<void> {
    if(this.stopped)return Promise.resolve();
    if(!this.pending)this.pending=this.reconcile().finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  private async reconcile() {
    const wanted=lanAddresses((this.options.interfaces ?? networkInterfaces)()),errors:LanState['errors']=[];
    for(const [address,port] of this.listeners)if(!wanted.includes(address)) {
      this.announcements.get(address)?.();this.announcements.delete(address);
      await this.target.removeLanListener(address,port);this.listeners.delete(address);
    }
    for(const address of wanted)if(!this.listeners.has(address)) {
      try { this.listeners.set(address,await this.target.addLanListener(address,this.port)); }
      catch(e:any) { errors.push({address,code:typeof e.code==='string'?e.code:'LAN_BIND_FAILED'}); }
    }
    for(const address of this.listeners.keys())if(!this.announcements.has(address)) {
      try { this.announcements.set(address,(this.options.advertise ?? advertise)(this.target.serverId,this.port,address,false)); }
      catch { errors.push({address,code:'DISCOVERY_UNAVAILABLE'}); }
    }
    const state:LanState={automatic:true,urls:[...this.listeners].map(([a,p])=>`http://${a}:${p}`),
      memberUrl:this.listeners.size&&this.options.memberHostname?`http://${this.options.memberHostname}:${this.port}`:null,
      discoveryUrl:this.announcements.size?`http://dsh-${this.target.serverId}.local:${this.port}`:null,errors};
    const signature=JSON.stringify(state);
    if(signature!==this.last){this.options.changed(state);this.last=signature;}
  }
  async stop() { this.stopped=true;clearInterval(this.timer);await this.pending;for(const stop of this.announcements.values())stop();this.announcements.clear(); }
}
