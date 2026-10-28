const { normalizeOrigin } = require('./connection.cjs');
// Discovery is an address hint, not authentication. No passwords, cookies or writes travel here.
async function restoreSaved(saved, { probe, discover, connect }) {
  if (!saved?.origin || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(saved.serverId || '')) throw new Error('请先选择并确认团队服务器');
  const origin = normalizeOrigin(saved.origin);
  let current;
  try { current = await probe(origin); } catch { /* An unavailable old address may have moved. */ }
  if (current) {
    if (current.status.serverId !== saved.serverId) throw new Error('旧地址的服务器身份已变化，请核对后重新选择');
    return connect(origin, saved.serverId);
  }
  const candidates = await discover();
  for (const item of candidates.filter(c => c.serverId === saved.serverId).slice(0, 8)) {
    let checked;
    try { checked = await probe(normalizeOrigin(item.origin)); } catch { continue; }
    if (checked.status.serverId !== saved.serverId) continue;
    const result = await connect(checked.origin, saved.serverId);
    return { ...result, moved: checked.origin !== origin };
  }
  throw new Error('尚未找到原主机，请确认与主机连接同一局域网；也可填写主机控制台显示的新地址');
}
module.exports = { restoreSaved };
