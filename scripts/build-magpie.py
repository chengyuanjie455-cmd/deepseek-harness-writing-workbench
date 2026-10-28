"""Build the pinned, embedded Magpie source without touching a live installation."""
from pathlib import Path
import hashlib, json, os, platform, subprocess, shutil

source = Path(__file__).resolve().parents[1]
system = {'Darwin': 'darwin', 'Linux': 'linux', 'Windows': 'windows'}[platform.system()]
arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64'}[platform.machine()]
target = source / 'runtime' / f'magpie-host-{system}-{arch}'
target.parent.mkdir(parents=True, exist_ok=True)
env = dict(os.environ)
env['CGO_ENABLED'] = '0'
subprocess.run(['go', 'build', '-tags', 'nogui', '-trimpath', '-o', str(target), './cmd/wawu-host'], cwd=source/'vendor/magpie', env=env, check=True)
receipt = {'upstreamCommit': json.loads((source/'vendor/magpie.UPSTREAM.json').read_text())['commit'], 'binary': target.name, 'bytes': target.stat().st_size, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
target.with_suffix('.json').write_text(json.dumps(receipt, indent=2)+'\n')
# Carry the licenses of modules linked into this actual headless binary.
modules = subprocess.check_output(['go', 'list', '-deps', '-tags', 'nogui', '-f', '{{with .Module}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}', './cmd/wawu-host'], cwd=source/'vendor/magpie', env=env, text=True)
license_root = source/'licenses/magpie-go'
license_root.mkdir(parents=True, exist_ok=True)
inventory = []
for entry in sorted(set(modules.splitlines())):
    if not entry.strip(): continue
    name, version, directory = entry.split('|', 2)
    folder = license_root/name.replace('/', '__')
    folder.mkdir(parents=True, exist_ok=True)
    copied = []
    for item in Path(directory).iterdir():
        if item.is_file() and item.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE')):
            destination = folder/item.name
            # The candidate tree may already contain a content-verified,
            # read-only license snapshot.  Rebuilding must be idempotent:
            # reuse an identical file and fail closed on drift instead of
            # trying to overwrite it and producing a false build failure.
            if destination.exists():
                if destination.read_bytes() != item.read_bytes():
                    raise RuntimeError(f'License changed for linked module: {name}/{item.name}')
            else:
                shutil.copy2(item, destination)
            copied.append(item.name)
    if not copied:
        raise RuntimeError('License not found for linked module: '+name)
    inventory.append({'module':name, 'version':version, 'files':[str((folder/n).relative_to(source)) for n in copied]})
(license_root/'modules.json').write_text(json.dumps(inventory, indent=2)+'\n')
print(json.dumps(receipt))
