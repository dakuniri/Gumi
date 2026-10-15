// electron-builder の afterPack フック。
// macOS: 証明書が無くても Apple Silicon で起動でき、アクセシビリティ / 画面収録の許可を
// 与えられるよう、.app 全体にアドホック署名 (codesign -s -) をする。
// (electron-builder が Info.plist を書き換えると元の署名が無効になり、「壊れている」と表示されるため)
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing  ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
