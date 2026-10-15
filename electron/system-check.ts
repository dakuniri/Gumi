/**
 * 実機での PC 操作エンジン動作確認 (Windows / macOS)。
 *   npm run test:system            … 読み取りのみの確認 (画面・ウィンドウ・UI 要素など)
 *   npm run test:system -- --input … マウスを少し動かして元に戻す確認も行う
 *   npm run test:system -- --web   … DuckDuckGo で実際に検索する確認も行う
 * 結果は PASS / FAIL / SKIP で表示し、FAIL があれば終了コード 1 を返す。
 * macOS で権限 (アクセシビリティ / 画面収録) が無い項目は SKIP にする (CI 用)。
 */
import { app, systemPreferences } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { createAutomation } from '../src/services/automation';
import { SPEED_PROFILES, sleep } from '../src/services/automation/util';
import { parseCombo, pasteCombo } from '../src/services/automation/keys';
import { captureScreen, listDisplays } from '../src/services/screenshots/capture';
import { imageToScreen } from '../src/services/computer-use/coords';
import { MAX_FETCHED_SITES, runWebSearch } from '../src/services/web/search';

type Result = { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string };
const results: Result[] = [];

class Skip extends Error {}

async function check(name: string, fn: () => Promise<string> | string) {
  try {
    results.push({ name, status: 'PASS', detail: await fn() });
  } catch (err) {
    results.push({ name, status: err instanceof Skip ? 'SKIP' : 'FAIL', detail: (err as Error).message });
  }
}

app.whenReady().then(async () => {
  const isMac = process.platform === 'darwin';
  const withInput = process.argv.includes('--input');
  const automation = createAutomation({
    speed: () => SPEED_PROFILES.normal,
    workDir: path.join(os.tmpdir(), 'gumi-system-check'),
  });
  const { input, windows, ui } = automation;

  let trusted = true;
  let screenGranted = true;
  if (isMac) {
    const ax = await ui.ping().catch(() => ({ trusted: false }));
    trusted = !!ax.trusted;
    screenGranted = systemPreferences.getMediaAccessStatus('screen') === 'granted';
  }
  const needTrusted = () => {
    if (!trusted) throw new Skip('アクセシビリティの許可がありません');
  };
  const needScreen = () => {
    if (!screenGranted) throw new Skip('画面収録の許可がありません');
  };

  await check(`${isMac ? 'macOS (CoreGraphics / AX)' : 'Win32'} API (koffi) の読み込み`, () => {
    if (!automation.available) throw new Error(automation.error ?? '読み込めません');
    return `OK (${automation.platform})`;
  });
  await check('キー配列 (貼り付けのショートカット)', () => parseCombo(pasteCombo()).map((k) => `${k.name}=0x${k.vk.toString(16)}`).join(' + '));
  await check('カーソル位置の取得', () => {
    const c = input.getCursor();
    return `(${c.x}, ${c.y})`;
  });
  await check('仮想スクリーン / ディスプレイ / 倍率', () => {
    const v = input.virtualScreen();
    const d = listDisplays()
      .map((x) => `#${x.index}${x.primary ? '*' : ''} ${x.physical.width}x${x.physical.height}@(${x.physical.x},${x.physical.y}) ${Math.round(x.scaleFactor * 100)}%`)
      .join(' / ');
    return `virtual ${v.width}x${v.height}@(${v.x},${v.y}); ${d}`;
  });
  await check('入力の経過時間 / ボタン状態', () => `最後の入力から ${input.msSinceLastInput()}ms, 左ボタン ${input.isMouseButtonDown('left') ? '押下中' : '離れている'}`);
  await check('画面キャプチャと座標変換', async () => {
    needScreen();
    const d = listDisplays().find((x) => x.primary)!;
    const shot = await captureScreen({ display: d, maxLongEdge: 1280, jpegQuality: 80 });
    const br = imageToScreen(shot.frame, { x: shot.frame.imageWidth, y: shot.frame.imageHeight });
    if (br.x !== d.physical.x + d.physical.width || br.y !== d.physical.y + d.physical.height) {
      throw new Error(`右下が一致しません ${JSON.stringify(br)}`);
    }
    return `${shot.frame.imageWidth}x${shot.frame.imageHeight}, ${Math.round(shot.bytes / 1024)}KB`;
  });
  await check('ウィンドウ列挙 / アクティブウィンドウ', async () => {
    await windows.sync?.();
    const ws = windows.list([process.pid]);
    const fg = windows.foreground([process.pid]);
    // ウィンドウタイトルは個人的な内容を含みうるので表示しない
    return `${ws.length} 個, アクティブ: ${fg ? fg.processName : 'なし'}`;
  });
  await check('プロセス一覧', () => {
    const ps = automation.processes.list();
    if (ps.length === 0) throw new Error('0 個');
    return `${ps.length} 個`;
  });
  await check(isMac ? 'アクセシビリティ ワーカー' : 'UI Automation ホスト', async () => {
    const p = await ui.ping();
    return isMac ? `trusted: ${p.trusted}, windowIdApi: ${p.windowIdApi}` : `PowerShell ${p.psVersion}, DPI aware: ${p.dpiAware}`;
  });
  await check('UI 要素の取得 (アクティブウィンドウ)', async () => {
    if (isMac) needTrusted();
    const fg = windows.foreground([process.pid]);
    if (!fg) return 'アクティブウィンドウなし';
    const tree = await ui.listElements({ hwnd: fg.hwnd, interactiveOnly: true, maxCount: 60 });
    return `${fg.processName}: ${tree.elements.length} 要素 (${tree.elapsedMs}ms)`;
  });
  await check('カーソル位置の UI 要素', async () => {
    if (isMac) needTrusted();
    const c = input.getCursor();
    const e = await ui.elementAt(c.x, c.y);
    return e ? `${e.type}` : '要素なし';
  });
  await check(isMac ? 'アプリケーション一覧' : 'スタートメニューのアプリ一覧', async () => {
    const apps = await ui.startApps();
    if (apps.length === 0) throw new Error('0 件');
    return `${apps.length} 件`;
  });

  if (process.argv.includes('--web')) {
    await check('DuckDuckGo 検索 (本文取得は最大 3 サイト)', async () => {
      const out = await runWebSearch('Electron デスクトップアプリ', { pages: 3, signal: AbortSignal.timeout(60_000) });
      if (out.results.length === 0) throw new Error('検索結果が 0 件です');
      if (out.pages.length > MAX_FETCHED_SITES) throw new Error(`${out.pages.length} サイト取得しました`);
      const ok = out.pages.filter((p) => !('error' in p)).length;
      return `結果 ${out.results.length} 件、本文取得 ${ok}/${out.pages.length} サイト (1 位: ${out.results[0].url})`;
    });
  } else {
    results.push({ name: 'DuckDuckGo 検索', status: 'SKIP', detail: '--web を付けると実行します' });
  }

  if (withInput) {
    await check('マウス移動 (元の位置へ戻す)', async () => {
      if (isMac) needTrusted();
      const start = input.getCursor();
      const target = { x: start.x + (start.x > 200 ? -60 : 60), y: start.y };
      await input.moveTo(target.x, target.y, { durationMs: 150 });
      await sleep(50);
      const moved = input.getCursor();
      await input.moveTo(start.x, start.y, { smooth: false });
      if (Math.abs(moved.x - target.x) > 1 || Math.abs(moved.y - target.y) > 1) {
        throw new Error(`期待 ${JSON.stringify(target)} / 実際 ${JSON.stringify(moved)}`);
      }
      return `(${start.x},${start.y}) から (${moved.x},${moved.y}) へ移動して戻しました`;
    });
    await check('押下中の入力の解放', () => {
      const r = input.releaseAll();
      return `keys ${r.keys}, buttons ${r.buttons}`;
    });
  } else {
    results.push({ name: 'マウス移動', status: 'SKIP', detail: '--input を付けると実行します' });
  }

  ui.dispose();
  await sleep(10);
  const w = Math.max(...results.map((r) => r.name.length));
  console.log('\nGumi system check');
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(w)}  ${r.detail}`);
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`}`);
  app.exit(failed === 0 ? 0 : 1);
});
