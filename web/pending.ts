export type PendingKey = { session: string; requestId: string; created: string };
export function pendingKey(server: string, owner: string) { return 'team.pending.' + server + '.' + owner; }
export function readPending(storage: Pick<Storage,'getItem'>, key: string): PendingKey | undefined {
  try {
    const p=JSON.parse(storage.getItem(key)||'null');
    if(p && typeof p.session==='string' && /^[a-f0-9-]{36}$/.test(p.session) && /^[a-zA-Z0-9_-]{8,100}$/.test(p.requestId) && typeof p.created==='string') return {session:p.session,requestId:p.requestId,created:p.created};
  } catch {}
}
export function savePending(storage: Pick<Storage,'setItem'>, key: string, body: { session: string; requestId: string }) {
  storage.setItem(key, JSON.stringify({session:body.session,requestId:body.requestId,created:new Date().toISOString()}));
}
