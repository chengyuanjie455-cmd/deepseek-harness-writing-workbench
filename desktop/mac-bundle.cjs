const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function readPlist(file) {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
}

// Electron discovers each child process by CFBundleName, not by the outer .app
// directory or its display name. Signing alone does not verify these paths.
function validateMacBundle(bundle) {
  const info = readPlist(path.join(bundle, 'Contents', 'Info.plist'));
  const checkExecutable = (root, plist, expected) => {
    if (expected && plist.CFBundleExecutable !== expected) throw Error(`辅助程序名称不一致：${expected}`);
    const name = plist.CFBundleExecutable;
    if (typeof name !== 'string' || !name || path.basename(name) !== name) throw Error('应用可执行文件名无效');
    fs.accessSync(path.join(root, 'Contents', 'MacOS', name), fs.constants.X_OK);
  };
  const name = info.CFBundleName;
  if (typeof name !== 'string' || !name || path.basename(name) !== name) throw Error('CFBundleName 无效');
  checkExecutable(bundle, info);
  const helpers = [' Helper', ' Helper (Renderer)', ' Helper (GPU)', ' Helper (Plugin)'];
  for (const suffix of helpers) {
    const expected = name + suffix;
    const root = path.join(bundle, 'Contents', 'Frameworks', expected + '.app');
    if (!fs.existsSync(root)) throw Error(`缺少 Electron 辅助程序：${expected}.app`);
    checkExecutable(root, readPlist(path.join(root, 'Contents', 'Info.plist')), expected);
  }
  return { name, executable: info.CFBundleExecutable, helperCount: helpers.length };
}
module.exports = { validateMacBundle };
