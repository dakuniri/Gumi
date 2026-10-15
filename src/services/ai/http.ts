/**
 * AI API 呼び出し用の HTTP ヘルパー。
 * - 429 / 5xx / ネットワークエラーを指数バックオフで再試行 (Retry-After 対応)
 * - AbortSignal で即時キャンセル
 * - エラーメッセージから API キーを除去
 */
import { ApiError } from './types';
import { sleep } from '../automation/util';

export interface PostOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  maxRetries: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  method?: 'POST' | 'GET';
}

function isRetryableStatus(s: number): boolean {
  return s === 408 || s === 409 || s === 425 || s === 429 || s >= 500;
}

function sanitize(text: string, headers: Record<string, string>): string {
  let out = text;
  for (const v of Object.values(headers)) {
    const secret = v.replace(/^Bearer\s+/i, '');
    if (secret.length >= 12) out = out.split(secret).join('***');
  }
  return out;
}

function extractErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    if (typeof e === 'string') return e;
    if (e?.message) return String(e.message);
    if (j.message) return String(j.message);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 300);
}

export function describeStatus(status: number): string {
  switch (status) {
    case 400:
      return 'リクエストが不正です';
    case 402:
      return 'AI サービスの残高 (クレジット) が不足しています。プロバイダーの管理画面でチャージしてください';
    case 401:
      return 'API キーが無効です';
    case 403:
      return 'アクセスが拒否されました (権限・地域・モデル利用可否を確認してください)';
    case 404:
      return 'エンドポイントまたはモデルが見つかりません';
    case 413:
      return 'リクエストが大きすぎます';
    case 429:
      return 'レート制限または利用上限に達しました';
    default:
      return status >= 500 ? 'AI サービス側でエラーが発生しました' : `HTTP ${status}`;
  }
}

export async function requestJson<T = any>(opts: PostOptions): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  let attempt = 0;
  for (;;) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), opts.timeoutMs ?? 180_000);
    const onAbort = () => timeout.abort();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await doFetch(opts.url, {
        method: opts.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: opts.method === 'GET' ? undefined : JSON.stringify(opts.body),
        signal: timeout.signal,
      });
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new ApiError('AI API の応答を解析できませんでした', res.status, false, text.slice(0, 500));
        }
      }
      const retryable = isRetryableStatus(res.status);
      const msg = sanitize(`${describeStatus(res.status)}: ${extractErrorMessage(text)}`, opts.headers);
      if (retryable && attempt < opts.maxRetries) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : backoff(attempt);
        attempt++;
        await sleep(wait, opts.signal);
        continue;
      }
      throw new ApiError(msg, res.status, retryable, sanitize(text.slice(0, 1000), opts.headers));
    } catch (err) {
      if (opts.signal.aborted) throw err;
      if (err instanceof ApiError) throw err;
      // ネットワークエラー / タイムアウト
      const msg = timeout.signal.aborted ? 'AI API の応答がタイムアウトしました' : `AI API に接続できません: ${(err as Error).message}`;
      if (attempt < opts.maxRetries) {
        attempt++;
        await sleep(backoff(attempt), opts.signal);
        continue;
      }
      throw new ApiError(sanitize(msg, opts.headers), null, true);
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
    }
  }
}

export function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt + Math.floor(Math.random() * 400));
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
