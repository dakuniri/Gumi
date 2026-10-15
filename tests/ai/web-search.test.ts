import { describe, expect, it } from 'vitest';
import { parseDuckDuckGoHtml, resolveResultUrl } from '../../src/services/web/duckduckgo';
import { assertPublicUrl, fetchPageText, isPrivateAddress } from '../../src/services/web/page';
import { MAX_FETCHED_SITES, formatWebSearch, runWebSearch } from '../../src/services/web/search';
import { decodeEntities, htmlToText } from '../../src/services/web/html-text';
import { validateToolCall } from '../../src/services/computer-use/tools';

/** DuckDuckGo HTML 版と同じ構造の合成データ */
function ddgHtml(n: number, opts: { ad?: boolean } = {}): string {
  const blocks: string[] = [];
  if (opts.ad) {
    blocks.push(
      `<div class="result results_links results_links_deep result--ad "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x.com&amp;u3=1">Ad</a></h2><a class="result__snippet" href="#">buy</a></div>`,
    );
  }
  for (let i = 1; i <= n; i++) {
    const target = encodeURIComponent(`https://site${i}.example.com/page?x=${i}`);
    blocks.push(
      `<div class="result results_links results_links_deep web-result "><div class="links_main"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${target}&amp;rut=abc">Title <b>${i}</b> &amp; more</a></h2><a class="result__snippet" href="//duckduckgo.com/l/?uddg=${target}">Snippet ${i} &#x3042;</a></div></div>`,
    );
  }
  return `<html><body><div class="results">${blocks.join('\n')}</div></body></html>`;
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('DuckDuckGo parsing', () => {
  it('extracts title, real URL and snippet; skips ads', () => {
    const r = parseDuckDuckGoHtml(ddgHtml(3, { ad: true }));
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({ title: 'Title 1 & more', url: 'https://site1.example.com/page?x=1', snippet: 'Snippet 1 あ' });
  });

  it('limits result count and resolves redirect links', () => {
    expect(parseDuckDuckGoHtml(ddgHtml(15), 10)).toHaveLength(10);
    expect(resolveResultUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2F&amp;rut=1')).toBe('https://a.com/');
    expect(resolveResultUrl('https://duckduckgo.com/y.js?ad=1')).toBeNull();
    expect(resolveResultUrl('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)')).toBeNull();
  });
});

describe('HTML to text', () => {
  it('drops scripts/styles/navigation and keeps paragraphs', () => {
    const t = htmlToText(
      '<html><head><title>T</title><style>.a{}</style></head><body><nav>menu</nav><script>evil()</script><h1>見出し</h1><p>本文&nbsp;です</p><ul><li>一</li><li>二</li></ul></body></html>',
    );
    expect(t).not.toMatch(/evil|menu|\.a\{/);
    expect(t).toContain('見出し');
    expect(t).toContain('本文 です');
    expect(t).toContain('- 一');
    expect(decodeEntities('&lt;a&gt; &#12354; &#x3044;')).toBe('<a> あ い');
  });
});

describe('network safety', () => {
  it('detects private and loopback addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:192.168.1.1', '0.0.0.0']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '2001:4860:4860::8888']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('rejects local URLs, other schemes and hosts resolving to private IPs', async () => {
    await expect(assertPublicUrl('http://localhost:3000/')).rejects.toThrow();
    await expect(assertPublicUrl('http://192.168.1.1/')).rejects.toThrow();
    await expect(assertPublicUrl('file:///C:/Windows/win.ini')).rejects.toThrow();
    await expect(assertPublicUrl('https://user:pw@example.com/')).rejects.toThrow();
    await expect(assertPublicUrl('https://evil.example/', async () => [{ address: '10.0.0.5', family: 4 }])).rejects.toThrow();
    await expect(assertPublicUrl('https://example.com/', publicLookup)).resolves.toBeInstanceOf(URL);
  });

  it('re-validates redirect targets', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })) as unknown as typeof fetch;
    await expect(
      fetchPageText('https://example.com/', { signal: new AbortController().signal, fetchImpl, lookup: publicLookup }),
    ).rejects.toThrow(/ローカル/);
  });
});

describe('web_search: at most 3 websites fetched', () => {
  function mockWeb(results: number, failSite?: number) {
    const visited: string[] = [];
    const fetchImpl = (async (url: string) => {
      visited.push(url);
      if (url.startsWith('https://html.duckduckgo.com/')) return new Response(ddgHtml(results), { status: 200 });
      const n = Number(/site(\d+)/.exec(url)?.[1]);
      if (n === failSite) return new Response('no', { status: 500 });
      return new Response(`<html><head><title>Site ${n}</title></head><body><p>内容 ${n}</p></body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, visited };
  }

  it('fetches only the top 3 even if more are requested', async () => {
    const { fetchImpl, visited } = mockWeb(10);
    const out = await runWebSearch('gumi', { pages: 10, signal: new AbortController().signal, fetchImpl, lookup: publicLookup });
    expect(MAX_FETCHED_SITES).toBe(3);
    expect(out.results).toHaveLength(10);
    expect(out.pages).toHaveLength(3);
    expect(visited.filter((u) => !u.includes('duckduckgo.com'))).toHaveLength(3);
    const text = formatWebSearch(out);
    expect(text).toContain('内容 1');
    expect(text).not.toContain('内容 4');
  });

  it('counts failed sites toward the limit (never contacts a 4th site)', async () => {
    const { fetchImpl, visited } = mockWeb(10, 2);
    const out = await runWebSearch('gumi', { pages: 3, signal: new AbortController().signal, fetchImpl, lookup: publicLookup });
    expect(visited.filter((u) => !u.includes('duckduckgo.com'))).toHaveLength(3);
    expect(out.pages.filter((p) => 'error' in p)).toHaveLength(1);
  });

  it('can skip page fetching and rejects fetch_pages above 3 at the tool level', async () => {
    const { fetchImpl, visited } = mockWeb(5);
    await runWebSearch('gumi', { pages: 0, signal: new AbortController().signal, fetchImpl, lookup: publicLookup });
    expect(visited).toHaveLength(1);
    expect(() => validateToolCall('web_search', { query: 'x', fetch_pages: 4 })).toThrow();
    expect(validateToolCall('web_search', { query: 'x' }).args.fetch_pages).toBe(3);
  });

  it('reports DuckDuckGo rate limiting clearly', async () => {
    const fetchImpl = (async () => new Response('<div class="anomaly-modal">', { status: 202 })) as unknown as typeof fetch;
    await expect(runWebSearch('x', { pages: 3, signal: new AbortController().signal, fetchImpl })).rejects.toThrow(/制限/);
  });
});
