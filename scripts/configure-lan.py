#!/usr/bin/env python3
"""Prepare a project-local LAN profile; does not install trust or restart services."""
from pathlib import Path
import argparse, datetime, ipaddress, json, os, shutil, subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--address', required=True)
parser.add_argument('--data', type=Path, default=Path(__file__).resolve().parents[1] / 'data')
parser.add_argument('--port', type=int, default=4317)
parser.add_argument('--discovery', action='store_true', help='Advertise this server on the selected LAN')
parser.add_argument('--http', action='store_true', help='Explicit password-only private LAN HTTP mode without TLS')
args = parser.parse_args()
address = ipaddress.ip_address(args.address)
networks = [ipaddress.ip_network(n) for n in ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8']]
if address.version != 4 or not any(address in n for n in networks) or not 1024 <= args.port <= 65535:
    parser.error('使用私有 IPv4 地址和 1024–65535 端口')
data = args.data.resolve(); data.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(data, 0o700)
if args.http:
    os.umask(0o077)
    url = f'http://{address}:{args.port}/'
    config = {'PORT': str(args.port), 'PLATFORM_BIND': str(address), 'PLATFORM_ALLOWED_HOSTS': str(address), 'PLATFORM_ALLOW_LAN_HTTP': '1', 'PLATFORM_KEEP_AWAKE': '1'}
    if args.discovery and not address.is_loopback: config['PLATFORM_DISCOVERY'] = '1'
    if not address.is_loopback: config['PLATFORM_LOCAL_REDIRECT'] = url
    target = data / 'service-config.json'
    if target.exists(): shutil.copy2(target, data / ('service-config-before-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.json'))
    temporary = data / 'service-config.tmp'; temporary.write_text(json.dumps(config, indent=2) + '\n')
    os.chmod(temporary, 0o600); temporary.replace(target)
    print(json.dumps({'state': 'prepared_not_restarted', 'url': url, 'transport': 'http', 'certificate_required': False, 'login_required': True}, ensure_ascii=False))
    raise SystemExit(0)
tls = data / 'tls'; tls.mkdir(exist_ok=True, mode=0o700)
openssl = shutil.which('openssl')
if not openssl: raise SystemExit('需要已安装的 OpenSSL')
def run(*argv):
    return subprocess.run([openssl, *map(str, argv)], check=True, capture_output=True, text=True).stdout
os.umask(0o077)
network = ipaddress.ip_network(f'{address}/24', strict=False)
ca = tls / 'team-ca.crt'; ca_key = tls / 'team-ca.key'; metadata = tls / 'ca-scope.json'
if ca.exists() != ca_key.exists(): raise SystemExit('CA 文件不完整，停止以免覆盖')
if not ca.exists():
    conf = tls / 'ca.cnf'
    conf.write_text(f'''[req]
distinguished_name=dn
x509_extensions=ca
prompt=no
[dn]
CN=DeepSeek Team LAN CA
O=Local AI Workflow Platform
[ca]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
nameConstraints=critical,permitted;IP:{network.network_address}/{network.netmask},permitted;IP:127.0.0.1/255.255.255.255,permitted;DNS:localhost
''')
    run('req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650', '-keyout', ca_key, '-out', ca, '-config', conf)
    metadata.write_text(json.dumps({'ipv4_network':str(network)}) + '\n')
elif not metadata.exists() or address not in ipaddress.ip_network(json.loads(metadata.read_text())['ipv4_network']):
    raise SystemExit('地址超出已有 CA 的网络范围，需要单独迁移证书，未覆盖旧 CA')
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
leaf = tls / stamp; leaf.mkdir(mode=0o700)
key = leaf / 'server.key'; cert = leaf / 'server.crt'; csr = leaf / 'server.csr'; ext = leaf / 'server.cnf'
ext.write_text(f'''basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:{address},IP:127.0.0.1,DNS:localhost
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
''')
run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', f'/CN={address}/O=Local AI Workflow Platform', '-keyout', key, '-out', csr)
run('x509', '-req', '-in', csr, '-CA', ca, '-CAkey', ca_key, '-set_serial', '0x' + os.urandom(16).hex(), '-days', '365', '-sha256', '-extfile', ext, '-out', cert)
run('verify', '-CAfile', ca, '-verify_ip', address, cert)
url = f'https://{address}:{args.port}/'
config = {'PORT':str(args.port), 'PLATFORM_BIND':str(address), 'PLATFORM_ALLOWED_HOSTS':str(address), 'PLATFORM_TLS_CERT':str(cert), 'PLATFORM_TLS_KEY':str(key), 'PLATFORM_TLS_CA':str(ca), 'PLATFORM_KEEP_AWAKE':'1'}
if not address.is_loopback: config['PLATFORM_LOCAL_REDIRECT'] = url
target = data / 'service-config.json'
if target.exists(): shutil.copy2(target, tls / f'service-config-before-{stamp}.json')
temporary = data / 'service-config.tmp'
temporary.write_text(json.dumps(config, indent=2) + '\n'); os.chmod(temporary, 0o600); temporary.replace(target)
print(json.dumps({'state':'prepared_not_restarted', 'url':url, 'ca_certificate':str(ca), 'certificate':str(cert), 'ca_fingerprint':run('x509','-in',ca,'-noout','-fingerprint','-sha256').strip(), 'leaf_dates':run('x509','-in',cert,'-noout','-dates').strip()}, ensure_ascii=False))
