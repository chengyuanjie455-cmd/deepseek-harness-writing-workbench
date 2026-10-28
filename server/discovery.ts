import Bonjour from 'bonjour-service';
import { isIPv4 } from 'node:net';

export function advertise(serverId: string, port: number, bind: string, tls: boolean) {
  if (!isIPv4(bind) || bind.startsWith('127.')) throw new Error('自动发现仅用于已配置的局域网接口');
  // bonjour-service types this as ServiceConfig, but forwards it unchanged to multicast-dns.
  // mDNS receives multicast destinations, so its UDP socket must not bind a unicast IP.
  // HTTP listeners remain bound to concrete private addresses; multicast uses this interface only.
  const options = { interface: bind, bind: '0.0.0.0' } as ConstructorParameters<typeof Bonjour>[0];
  const bonjour = new Bonjour(options, () => console.error('discovery_unavailable'));
  const service = bonjour.publish({ name: 'DeepSeek Team ' + serverId.slice(0, 8) + ' (' + bind + ')', type: 'dshteam', protocol: 'tcp',
    host: 'dsh-' + serverId + '.local', port, disableIPv6: true,
    txt: { server_id: serverId, protocol: '1', transport: tls ? 'https' : 'http' } });
  // The dependency normally announces every NIC; expose only the explicitly selected team interface.
  const records = service.records.bind(service);
  service.records = () => records().filter(r => r.type !== 'AAAA' && (r.type !== 'A' || r.data === bind));
  service.on('error', () => console.error('discovery_unavailable'));
  return () => { service.stop(); bonjour.destroy(); };
}
