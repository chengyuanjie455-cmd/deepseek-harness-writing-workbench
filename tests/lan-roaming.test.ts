import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {NetworkInterfaceInfo} from 'node:os';
import {LanRoaming,lanAddresses,type LanState} from '../server/lan-roaming.ts';
const nic=(address:string,internal=false):NetworkInterfaceInfo=>({address,internal,family:'IPv4',netmask:'255.255.255.0',mac:'00:11:22:33:44:55',cidr:address+'/24'});

test('roaming selects concrete physical private addresses, never public, loopback, VPN or bridge',()=>{
 assert.deepEqual(lanAddresses({en0:[nic('192.168.210.42'),nic('fe80::1')],en7:[nic('10.2.0.5'),nic('192.168.210.42')],en8:[nic('8.8.8.8'),nic('169.254.1.1'),nic('127.0.0.1')],lo0:[nic('127.0.0.1',true)],utun4:[nic('10.9.0.1')],bridge0:[nic('192.168.64.1')],docker0:[nic('172.17.0.1')]}),['192.168.210.42','10.2.0.5']);
 assert.deepEqual(lanAddresses({'Wi-Fi':[nic('192.168.1.5')],Ethernet:[nic('172.31.0.8')],enp1s0:[nic('10.1.2.3')],wlp2s0:[nic('10.1.2.4')],tun0:[nic('10.1.2.5')]}),['172.31.0.8','192.168.1.5','10.1.2.3','10.1.2.4']);
});

test('office to offline to home changes listeners in place; occupied ports retry without losing healthy entry',async()=>{
 let network={en0:[nic('192.168.210.42')]},fail='',reads=0,stops=0;
 const active=new Set<string>(),added:string[]=[],removed:string[]=[],states:LanState[]=[],announced:string[]=[];
 const target={serverId:'11111111-1111-1111-1111-111111111111',async addLanListener(a:string,p:number){if(a===fail)throw Object.assign(new Error('occupied'),{code:'EADDRINUSE'});assert(!active.has(a));added.push(a);active.add(a);return p;},async removeLanListener(a:string){removed.push(a);active.delete(a);}};
 const m=new LanRoaming(target,4325,{memberHostname:'work-mac.local',interfaces:()=>{reads++;return network;},changed:s=>states.push(s),advertise:(_id,_port,address)=>{announced.push(address);return()=>{stops++;};}});
 await Promise.all([m.refresh(),m.refresh(),m.refresh()]);assert.equal(reads,1);assert.deepEqual([...active],['192.168.210.42']);assert.equal(states.length,1);
 await m.refresh();assert.equal(states.length,1,'unchanged network does not rewrite runtime');
 assert.equal(states.at(-1)?.memberUrl,'http://work-mac.local:4325');
 network={en0:[]};await m.refresh();assert.equal(active.size,0);assert.equal(states.at(-1)?.discoveryUrl,null);assert.equal(states.at(-1)?.memberUrl,null);assert.equal(stops,1);
 network={en0:[nic('192.168.200.10')]};fail='192.168.200.10';await m.refresh();assert.equal(states.at(-1)?.errors[0].code,'EADDRINUSE');assert.equal(active.size,0);
 fail='';await m.refresh();assert.deepEqual([...active],['192.168.200.10']);assert.deepEqual(states.at(-1)?.errors,[]);
 network={en0:[nic('192.168.200.10'),nic('192.168.200.254')]};fail='192.168.200.254';await m.refresh();assert.deepEqual([...active],['192.168.200.10']);
 fail='';await m.refresh();assert.equal(active.size,2);assert.equal(announced.length,3);
 assert.equal(states.at(-1)?.memberUrl,'http://work-mac.local:4325','both interfaces keep one origin');
 network={en0:[nic('192.168.210.42')]};await m.refresh();assert.deepEqual([...active],['192.168.210.42']);
 assert.deepEqual(removed,['192.168.210.42','192.168.200.10','192.168.200.254']);
 await m.stop();const before=reads;await m.refresh();assert.equal(reads,before);assert.equal(stops,4);
 assert.equal(target.serverId,'11111111-1111-1111-1111-111111111111');assert.equal(added.length,4);
 assert.equal(states.at(-1)?.memberUrl,'http://work-mac.local:4325','name stays stable across network changes');
});
