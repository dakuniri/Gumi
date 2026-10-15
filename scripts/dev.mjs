// 開発用ランチャー: Vite dev server + esbuild watch + Electron を起動する。
// Main/Preload が再ビルドされたら Electron を再起動する。
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { watchAll } from './build-electron.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const address = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173/';
console.log(`[dev] renderer: ${address}`);

let child = null;
let restarting = false;
let debounce = null;

function startElectron() {
  child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, GUMI_DEV_SERVER_URL: address },
  });
  child.on('exit', (code) => {
    if (!restarting) {
      console.log(`[dev] electron exited (${code})`);
      server.close();
      process.exit(code ?? 0);
    }
  });
}

function restart() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (!child) {
      startElectron();
      return;
    }
    restarting = true;
    child.once('exit', () => {
      restarting = false;
      startElectron();
    });
    child.kill();
  }, 200);
}

await watchAll(restart);
