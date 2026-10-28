export type Reference = { id: string; project: string; session?: string; text: string; name: string };

// A queued reference belongs to the chat that was selected when it was added.
// Waiting for its editor must never deliver it to another chat.
export function referencesForChat<T extends Reference>(rows: T[], project: string, session?: string): T[] {
  return session ? rows.filter(row => row.project === project && (!row.session || row.session === session)) : [];
}

export function sessionRows(byId: Record<string, any> = {}) {
  return Object.values(byId).filter(row => !row.id.startsWith('team-observe:'))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function validatedProjectURL(value: string, origin: string): URL {
  const target = new URL(value, origin);
  if (target.origin !== origin || !/^\/harness\/(shared|[a-f0-9-]{36})(~[a-f0-9-]{36})?\/$/.test(target.pathname)) {
    throw new Error('项目入口与当前主机不一致');
  }
  return target;
}
