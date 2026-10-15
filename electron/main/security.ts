/**
 * Electron のセキュリティ強化。
 * - 新規ウィンドウ / 外部ナビゲーション / webview を禁止
 * - 権限要求 (カメラ・通知など) を Renderer からは一切許可しない
 * - 外部コンテンツから Node.js を操作させない (nodeIntegration 無効 + sandbox)
 */
import { app, session, type WebContents } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAppUrl, rendererIndexPath } from './app-paths';

export function hardenApp(): void {
  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (e, url) => {
      if (!isAppUrl(url)) e.preventDefault();
    });
    contents.on('will-redirect', (e, url) => {
      if (!isAppUrl(url)) e.preventDefault();
    });
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
}

/** セッションの権限・通信制限 (app ready 後に呼ぶ) */
export function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // Renderer からの外部ネットワークアクセスを遮断 (AI API 通信は Main Process のみが行う)
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    if (url.startsWith('devtools://') || url.startsWith('data:') || isAppUrl(url) || isLocalAsset(url)) {
      callback({});
      return;
    }
    callback({ cancel: true });
  });
}

/** アプリ自身の画面ファイル (dist/) の中か。それ以外のローカルファイルは読ませない */
function isRendererFile(u: URL): boolean {
  const root = path.dirname(rendererIndexPath());
  const file = path.resolve(fileURLToPath(u));
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isLocalAsset(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return isRendererFile(u);
    const dev = process.env.GUMI_DEV_SERVER_URL;
    // 開発時は Vite dev server (HTTP と HMR 用 WebSocket) のみ許可
    return !!dev && !app.isPackaged && u.host === new URL(dev).host;
  } catch {
    return false;
  }
}

export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
  navigateOnDragDrop: false,
} as const;
