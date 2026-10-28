import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const storage = require('../desktop/external-storage.cjs');
const filename = require('../desktop/host-profile.cjs').policyFilename(require('../desktop/deployment.json'), process.env.PLATFORM_STORAGE_POLICY);
const policy = filename ? storage.loadPolicy(filename) : undefined;
if (policy) Object.assign(process.env, storage.environment(policy));
const state = policy ? storage.assertVolume(policy) : undefined;
export function assertStoragePath(target:string) {
  if (policy) {storage.checkAvailable(policy,state);storage.assertPath(policy,target,state);}
}
export function watchExternalStorage() {
  return policy ? storage.monitor(policy, () => {
    console.error('external_storage_unavailable: stopping host; no internal fallback');
    process.kill(process.pid, 'SIGTERM');
  }) : () => {};
}
