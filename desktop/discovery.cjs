const { Bonjour } = require('bonjour-service');
const { normalizeOrigin } = require('./connection.cjs');
const { networkInterfaces } = require('node:os');
function discoveryInterfaces(interfaces = networkInterfaces()) {
  const addresses = new Set();
  for (const [name,nics] of Object.entries(interfaces)) {
    if(!/^(?:en\d+|eth\d+|wlan\d+|en[opsx][\w.-]+|wl[px][\w.-]+|Wi-Fi(?: \d+)?|Ethernet(?: \d+)?)$/.test(name))continue;
    for(const nic of nics || [])if(!nic.internal && nic.family === 'IPv4') {
      try { normalizeOrigin('http://'+nic.address);addresses.add(nic.address); } catch {}
    }
  }
  return [...addresses].slice(0,8);
}
function discover(duration = 5000) {
  return new Promise(resolve => {
    const found = new Map(), clients = [];
    let done = false, timer;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); for(const c of clients){c.browser?.stop();c.bonjour.destroy();} resolve([...found.values()]); };
    const receive = service => {
      const id = service.txt?.server_id;
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || service.txt?.protocol !== '1') return;
      for (const address of (service.addresses ?? []).slice(0, 8)) {
        try {
          const origin = normalizeOrigin((service.txt.transport === 'https' ? 'https://' : 'http://') + address + ':' + service.port);
          if (found.size < 32) found.set(id + '|' + origin, { serverId: id, origin, name: String(service.name).slice(0, 80) });
        } catch {}
      }
    };
    // Query each eligible interface explicitly. The OS default route may use a different NIC.
    for(const address of discoveryInterfaces())try {
      const client={bonjour:new Bonjour({interface:address,bind:'0.0.0.0'},()=>{})};clients.push(client);
      client.browser=client.bonjour.find({ type: 'dshteam', protocol: 'tcp' },receive);
    }catch{}
    if(!clients.length)return finish();
    timer = setTimeout(finish, duration);
  });
}
module.exports = { discover, discoveryInterfaces };
