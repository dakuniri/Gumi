// ビルド成果物 (インストーラー / dmg) のサイズを確認し、上限を超えていたら失敗させる。
//   node scripts/check-artifact-size.mjs [release ディレクトリ] [上限 MB]
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'release';
const limitMb = Number(process.argv[3] ?? 500);
const targets = readdirSync(dir).filter((f) => /\.(exe|dmg|zip|AppImage)$/i.test(f) && !f.includes('__uninstaller'));

if (targets.length === 0) {
  console.error(`成果物が見つかりません: ${dir}`);
  process.exit(1);
}

let failed = false;
for (const f of targets) {
  const mb = statSync(path.join(dir, f)).size / 1024 / 1024;
  const ok = mb <= limitMb;
  if (!ok) failed = true;
  console.log(`${ok ? 'OK  ' : 'OVER'} ${f}  ${mb.toFixed(1)} MB (上限 ${limitMb} MB)`);
}
process.exit(failed ? 1 : 0);
