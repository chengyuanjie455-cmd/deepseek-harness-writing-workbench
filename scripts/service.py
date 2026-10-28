#!/usr/bin/env python3
"""Start/stop only this project's local preview; never installs a resident service."""
from pathlib import Path
import os, sys, subprocess, shutil, json, time, urllib.request, signal, ssl, fcntl, uuid
root = Path(__file__).resolve().parents[1]
data = Path(os.environ.get('PLATFORM_DATA', root / 'data')).resolve()
data.mkdir(parents=True, exist_ok=True, mode=0o700)
control_lock = (data / 'service-control.lock').open('a')
os.chmod(data / 'service-control.lock', 0o600)
fcntl.flock(control_lock, fcntl.LOCK_EX)
pid_file = data / 'service.pid'
entry = str(root / 'server' / 'main.ts')
action = sys.argv[1] if len(sys.argv) > 1 else 'status'
config_file = data / 'service-config.json'
config = json.loads(config_file.read_text()) if action != 'stop' and config_file.exists() else {}
allowed = {'PORT', 'PLATFORM_BIND', 'PLATFORM_ALLOWED_HOSTS', 'PLATFORM_TLS_CERT', 'PLATFORM_TLS_KEY', 'PLATFORM_TLS_CA', 'PLATFORM_LOCAL_REDIRECT', 'PLATFORM_KEEP_AWAKE', 'PLATFORM_ALLOW_LAN_HTTP', 'PLATFORM_DISCOVERY'}
if not isinstance(config, dict) or not set(config) <= allowed or not all(isinstance(v, str) for v in config.values()):
    raise SystemExit('服务配置字段无效')
def environment():
    env = {k:v for k,v in os.environ.items() if k in ['PATH','HOME','LANG','TMPDIR','DOCKER_CONFIG','PORT'] or k.startswith('PLATFORM_')}
    # An explicit command-line environment wins; saved settings survive normal restarts.
    env = {**config, **env, 'PLATFORM_DATA': str(data)}
    return env
def status_url(env):
    scheme = 'https' if env.get('PLATFORM_TLS_CERT') else 'http'
    bind = env.get('PLATFORM_BIND', '127.0.0.1')
    return f"{scheme}://{bind}:{env.get('PORT', '4317')}"
def running():
    if not pid_file.exists(): return None
    try:
        pid = int(pid_file.read_text())
        command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True)
        return pid if entry in command else None
    except (ValueError, subprocess.CalledProcessError): return None
if action == 'start':
    pid = running()
    if pid: print(json.dumps({'state':'already_running','pid':pid})); sys.exit(0)
    env = environment()
    env['PLATFORM_INSTANCE_ID'] = uuid.uuid4().hex
    with (data / 'service.log').open('ab') as log:
        os.chmod(data / 'service.log', 0o600)
        proc = subprocess.Popen([shutil.which('node'), '--import', 'tsx', entry], cwd=root, env=env, stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
    pid_file.write_text(str(proc.pid)); os.chmod(pid_file, 0o600)
    url = status_url(env)
    context = ssl.create_default_context(cafile=env.get('PLATFORM_TLS_CA'))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
    for _ in range(100):
        if proc.poll() is not None: raise SystemExit('启动失败，请查看本项目 data/service.log')
        try:
            with opener.open(url + '/api/status', timeout=1) as r: status = json.load(r)
            if status.get('serverInstance') != env['PLATFORM_INSTANCE_ID']:
                time.sleep(.1); continue
            print(json.dumps({'state':'running','pid':proc.pid,'url':url,'tls_verified':url.startswith('https:'),'status':status},ensure_ascii=False)); break
        except Exception: time.sleep(.1)
    else: raise SystemExit('服务启动仍未确认，请查看日志；未绕过证书校验')
elif action == 'stop':
    pid = running()
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(200):
            if not running(): break
            time.sleep(.1)
        else: raise SystemExit('停止尚未确认，请检查执行器状态')
    if pid_file.exists(): pid_file.unlink()
    print(json.dumps({'state':'stopped'}))
elif action == 'status': print(json.dumps({'state':'running' if running() else 'stopped','pid':running(),'configured_url':status_url(environment())}))
else: raise SystemExit('Usage: service.py start|stop|status')
