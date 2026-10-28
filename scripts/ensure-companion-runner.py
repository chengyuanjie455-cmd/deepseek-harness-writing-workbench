"""Register the existing HAPI runtime in the authenticated account's own namespace.

No model session is started here. Hub root credentials stay in owner-only plists.
"""
from pathlib import Path
import fcntl
import hashlib
import json
import os
import plistlib
import sqlite3
import subprocess
import sys
import uuid


def configuration(owner, server_id, account_id, username):
    uuid.UUID(account_id)
    namespace = 'wawu-' + hashlib.sha256(json.dumps([server_id, account_id], separators=(',', ':')).encode()).hexdigest()[:32]
    env = dict(owner['EnvironmentVariables'])
    token, old_namespace = env['CLI_API_TOKEN'].rsplit(':', 1)
    if namespace == old_namespace:
        return owner, namespace, True
    account_home = Path(env['HAPI_HOME']).parent / 'accounts' / account_id
    env.update(HAPI_HOME=str(account_home), CLI_API_TOKEN=token + ':' + namespace,
               HAPI_HOSTNAME=env.get('HAPI_HOSTNAME', '哇唔工作台') + ' · ' + username)
    result = dict(owner)
    result.update(Label='local.wawuwawu.remote-console.member.' + account_id, EnvironmentVariables=env)
    return result, namespace, False


def main(data, account_id):
    data = Path(data).resolve(strict=True)
    options = json.loads((data / 'companion-runner.json').read_text())
    assert options == {'enabled': True}, 'Invalid runner configuration'
    uuid.UUID(account_id)
    conn = sqlite3.connect((data / 'platform.sqlite').as_uri() + '?mode=ro', uri=True, timeout=3)
    user = conn.execute("SELECT body FROM docs WHERE kind='user' AND id=?", (account_id,)).fetchone()
    assert user, 'Unknown account'
    user = json.loads(user[0])
    assert user.get('active') and user.get('accountGatewayAllowed') is not False, 'Account disabled'
    server = json.loads(conn.execute("SELECT body FROM docs WHERE kind='runtime' AND id='server-identity'").fetchone()[0])['serverId']
    conn.close()
    agents = Path.home() / 'Library/LaunchAgents'
    owner_path = agents / 'local.wawuwawu.remote-console.plist'
    assert not owner_path.is_symlink() and owner_path.stat().st_uid == os.getuid()
    owner = plistlib.loads(owner_path.read_bytes())
    assert owner['ProgramArguments'][1:3] == ['runner', 'start-sync']
    conf, namespace, reused = configuration(owner, server, account_id, user['username'])
    home = Path(conf['EnvironmentVariables']['HAPI_HOME'])
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    assert not home.is_symlink()
    home.chmod(0o700)
    with (home / '.registration.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = owner_path if reused else agents / (conf['Label'] + '.plist')
        if path.exists():
            assert not path.is_symlink() and plistlib.loads(path.read_bytes()) == conf, 'Runner configuration changed'
        else:
            temp = path.with_suffix('.new')
            with temp.open('xb') as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(plistlib.dumps(conf))
            os.replace(temp, path)
        domain = 'gui/' + str(os.getuid())
        active = subprocess.run(['launchctl', 'print', domain + '/' + conf['Label']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3).returncode == 0
        if not active:
            subprocess.run(['launchctl', 'bootstrap', domain, str(path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    print(json.dumps({'state': 'registered', 'namespace': namespace, 'reusedOwner': reused}))


if __name__ == '__main__':
    try:
        main(*sys.argv[1:])
    except Exception:
        print('Companion runner registration failed', file=sys.stderr)
        sys.exit(1)
