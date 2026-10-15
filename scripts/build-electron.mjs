// Electron の Main / Preload を esbuild でバンドルする。
// Main は Node.js (CommonJS)、Preload は sandbox 下で動くため単一ファイル (CommonJS) にまとめる。
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist-electron');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'linked',
  logLevel: 'info',
  loader: { '.ps1': 'text' },
  absWorkingDir: root,
};

/**
 * macOS のアクセシビリティ ワーカー (src/services/automation/macos/ax-worker.ts) を単体のスクリプトにまとめる。
 * Main に文字列として埋め込み、worker_threads で eval して動かす (asar 内のファイルを読まずに済む)。
 * koffi はワーカーに渡されたパス (app.asar.unpacked 内) から読み込む。
 */
export async function buildAxWorker() {
  const r = await build({
    ...common,
    logLevel: 'warning',
    sourcemap: false,
    entryPoints: ['src/services/automation/macos/ax-worker.ts'],
    write: false,
    minify: true,
    plugins: [
      {
        name: 'koffi-from-worker-data',
        setup(b) {
          b.onResolve({ filter: /^koffi$/ }, () => ({ path: 'koffi', namespace: 'gumi-koffi' }));
          b.onLoad({ filter: /.*/, namespace: 'gumi-koffi' }, () => ({
            contents: "module.exports = require(require('node:worker_threads').workerData.koffiPath);",
            loader: 'js',
          }));
        },
      },
    ],
  });
  return r.outputFiles[0].text;
}

const withWorker = (code) => ({ __AX_WORKER_CODE__: JSON.stringify(code) });

export const configs = [
  {
    ...common,
    entryPoints: { main: 'electron/main/index.ts' },
    outdir,
    outExtension: { '.js': '.cjs' },
    // koffi はネイティブモジュールなのでバンドルしない (asarUnpack 対象)
    external: ['electron', 'koffi'],
  },
  {
    ...common,
    entryPoints: { preload: 'electron/preload/index.ts' },
    outdir,
    outExtension: { '.js': '.cjs' },
    external: ['electron'],
  },
  {
    // 実機動作確認用 (npm run test:system)
    ...common,
    entryPoints: { 'system-check': 'electron/system-check.ts' },
    outdir,
    outExtension: { '.js': '.cjs' },
    external: ['electron', 'koffi'],
  },
];

/** Main と動作確認スクリプトにはワーカーのコードを埋め込む */
function withDefines(c, workerCode) {
  return c.external?.includes('koffi') ? { ...c, define: { ...c.define, ...withWorker(workerCode) } } : c;
}

export async function buildAll() {
  const workerCode = await buildAxWorker();
  await Promise.all(configs.map((c) => build(withDefines(c, workerCode))));
}

export async function watchAll(onRebuild) {
  // ワーカーは起動時に 1 回だけビルドする (変更したら dev を再起動)
  const workerCode = await buildAxWorker();
  const ctxs = await Promise.all(
    configs.map((c) =>
      context({
        ...withDefines(c, workerCode),
        plugins: [
          {
            name: 'notify',
            setup(b) {
              b.onEnd((result) => {
                if (result.errors.length === 0) onRebuild?.();
              });
            },
          },
        ],
      }),
    ),
  );
  await Promise.all(ctxs.map((c) => c.watch()));
  return ctxs;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  buildAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
