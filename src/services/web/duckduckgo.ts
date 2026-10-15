/**
 * DuckDuckGo 検索 (HTML 版 html.duckduckgo.com を使用。API キー不要)。
 * 広告枠は除外し、DuckDuckGo の転送用リンクは元の URL に戻す。
 */
import { stripTags } from './html-text';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Gumi/0.1';

/** //duckduckgo.com/l/?uddg=... 形式のリンクを元の URL に戻す */
export function resolveResultUrl(href: string): string | null {
  const raw = href.replace(/&amp;/g, '&');
  try {
    const u = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://duckduckgo.com');
    if (u.hostname.endsWith('duckduckgo.com')) {
      const target = u.searchParams.get('uddg');
      if (!target) return null; // 広告 (y.js) などの内部リンク
      const t = new URL(target);
      return t.protocol === 'http:' || t.protocol === 'https:' ? t.toString() : null;
    }
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseDuckDuckGoHtml(html: string, maxResults = 10): SearchResult[] {
  const blocks = html.split(/<div class="result /).slice(1);
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const head = block.slice(0, 200);
    if (/result--ad/.test(head)) continue;
    const a = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = resolveResultUrl(a[1]);
    if (!url || seen.has(url)) continue;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/.exec(block);
    seen.add(url);
    out.push({ title: stripTags(a[2]).slice(0, 200), url, snippet: sn ? stripTags(sn[1]).slice(0, 400) : '' });
    if (out.length >= maxResults) break;
  }
  return out;
}

export async function searchDuckDuckGo(
  query: string,
  opts: { signal: AbortSignal; fetchImpl?: typeof fetch; maxResults?: number },
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) throw new Error('検索語が空です');
  const url = `${DDG_ENDPOINT}?q=${encodeURIComponent(q)}&kl=jp-jp`;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(20_000);
  const res = await doFetch(url, {
    headers: { 'user-agent': USER_AGENT, 'accept-language': 'ja,en;q=0.8' },
    signal: AbortSignal.any([opts.signal, timeout]),
  });
  const html = await res.text();
  if (res.status === 202 || /anomaly-modal|challenge-form/.test(html)) {
    throw new Error('DuckDuckGo が自動アクセスを一時的に制限しています。しばらく待ってから再試行してください。');
  }
  if (!res.ok) throw new Error(`DuckDuckGo の検索に失敗しました (HTTP ${res.status})`);
  return parseDuckDuckGoHtml(html, opts.maxResults ?? 10);
}
