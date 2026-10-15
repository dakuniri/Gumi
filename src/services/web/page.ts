/**
 * Web ページ本文の取得。
 * - http(s) のみ。ローカル / 社内ネットワーク (プライベート IP) へのアクセスは拒否
 * - リダイレクトは手動で追い、行き先も毎回検証する (最大 3 回)
 * - 取得サイズ・時間・文字数に上限を設ける
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { extractTitle, htmlToText } from './html-text';
import { USER_AGENT } from './duckduckgo';

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;

export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(v) === 6) {
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}

/** 外部の公開サイトだけを許可する */
export async function assertPublicUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`URL が不正です: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('http(s) 以外の URL は取得できません');
  if (u.username || u.password) throw new Error('認証情報を含む URL は取得できません');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('ローカルネットワークのアドレスは取得できません');
  }
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error('ローカル / 社内ネットワークのアドレスは取得できません');
  }
  return u;
}

async function defaultLookup(host: string) {
  return dnsLookup(host, { all: true });
}

function charsetOf(contentType: string, head: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, limit);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
    if (total >= limit) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, limit));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, out.length - off);
    out.set(c.subarray(0, n), off);
    off += n;
    if (off >= out.length) break;
  }
  return out;
}

export interface PageText {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export async function fetchPageText(
  url: string,
  opts: { signal: AbortSignal; fetchImpl?: typeof fetch; lookup?: LookupFn; maxChars?: number },
): Promise<PageText> {
  const doFetch = opts.fetchImpl ?? fetch;
  let current = await assertPublicUrl(url, opts.lookup);
  for (let i = 0; ; i++) {
    const res = await doFetch(current.toString(), {
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'ja,en;q=0.8', accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
      redirect: 'manual',
      signal: AbortSignal.any([opts.signal, AbortSignal.timeout(15_000)]),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (i >= MAX_REDIRECTS) throw new Error('リダイレクトが多すぎます');
      current = await assertPublicUrl(new URL(res.headers.get('location')!, current).toString(), opts.lookup);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      throw new Error(`テキストではないため取得しません (${type.split(';')[0]})`);
    }
    const bytes = await readLimited(res, MAX_BYTES);
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    const body = decode(bytes, charsetOf(type, head));
    const isHtml = /html/i.test(type) || /<html|<body|<p[\s>]/i.test(body.slice(0, 4000));
    const text = isHtml ? htmlToText(body) : body.trim();
    const max = opts.maxChars ?? 4000;
    return {
      url: current.toString(),
      title: isHtml ? extractTitle(body) : '',
      text: text.slice(0, max),
      truncated: text.length > max,
    };
  }
}
