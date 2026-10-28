// Presentation only, scoped to a frame already authenticated by NativeAccess.
async function applyPresentation(frame, access, connection, source) {
  if (!frame || frame.isDestroyed()) return false;
  const url = frame.url;
  if (!access.find(url, connection)) return false;
  await frame.executeJavaScript(source, false);
  return true;
}
module.exports = { applyPresentation };
