import { describe, expect, it, vi } from 'vitest';
import { AnthropicSession } from '../../src/services/ai/providers/anthropic';
import { OpenAiSession } from '../../src/services/ai/providers/openai';
import { GeminiSession, toGeminiSchema } from '../../src/services/ai/providers/gemini';
import { JsonToolSession, parseJsonToolCall } from '../../src/services/ai/providers/json-fallback';
import { createSession, validateConfig } from '../../src/services/ai/factory';
import { requestJson } from '../../src/services/ai/http';
import { ApiError, IMAGE_PLACEHOLDER, type ProviderConfig, type ToolSpec } from '../../src/services/ai/types';

const tools: ToolSpec[] = [
  { name: 'mouse_click', description: 'click', parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false } },
];
const img = { type: 'image' as const, mediaType: 'image/jpeg' as const, data: 'AAAA' };

function cfg(provider: ProviderConfig['provider'], extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    provider,
    model: 'test-model',
    endpoint: provider === 'anthropic' ? 'https://api.anthropic.com' : provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1',
    apiKey: 'secret-key-1234567890',
    maxTokens: 1024,
    temperature: null,
    supportsVision: true,
    supportsTools: true,
    maxRetries: 0,
    ...extra,
  };
}

function mockFetch(...bodies: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe('Anthropic session', () => {
  it('sends tools/system, parses tool_use and returns tool_result with images', async () => {
    const { fetch, calls } = mockFetch({
      content: [
        { type: 'text', text: 'クリックします' },
        { type: 'tool_use', id: 'tu_1', name: 'mouse_click', input: { x: 5 } },
      ],
      stop_reason: 'tool_use',
    });
    const s = new AnthropicSession({ config: cfg('anthropic'), system: 'SYS', tools, fetchImpl: fetch });
    s.addUser([{ type: 'text', text: 'task' }, img]);
    const turn = await s.next(new AbortController().signal);
    expect(turn.text).toBe('クリックします');
    expect(turn.toolCalls).toEqual([{ id: 'tu_1', name: 'mouse_click', args: { x: 5 } }]);

    const req = JSON.parse(String(calls[0].init.body));
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('secret-key-1234567890');
    expect(req.tools[0].input_schema.required).toEqual(['x']);
    expect(req.messages[0].content[1].source.media_type).toBe('image/jpeg');

    s.addToolResults([{ callId: 'tu_1', name: 'mouse_click', content: [{ type: 'text', text: 'ok' }, img] }]);
    const last = s.messages[s.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
  });

  it('prunes older images', () => {
    const s = new AnthropicSession({ config: cfg('anthropic'), system: '', tools });
    s.addUser([img]);
    s.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }] });
    s.addToolResults([{ callId: 'a', name: 'x', content: [img] }]);
    s.pruneImages(1);
    expect(JSON.stringify(s.messages[0])).toContain(IMAGE_PLACEHOLDER);
    expect(JSON.stringify(s.messages[2])).toContain('AAAA');
  });
});

describe('OpenAI-compatible session', () => {
  it('parses tool calls and attaches screenshots as a user message after tool messages', async () => {
    const { fetch, calls } = mockFetch({
      choices: [
        {
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mouse_click', arguments: '{"x":3}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const s = new OpenAiSession({ config: cfg('openai'), system: 'SYS', tools, fetchImpl: fetch });
    s.addUser([{ type: 'text', text: 'task' }]);
    const turn = await s.next(new AbortController().signal);
    expect(turn.toolCalls[0]).toMatchObject({ id: 'c1', name: 'mouse_click', args: { x: 3 } });
    const req = JSON.parse(String(calls[0].init.body));
    expect(req.max_completion_tokens).toBe(1024);
    expect(req.tools[0].function.name).toBe('mouse_click');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer secret-key-1234567890');

    s.addToolResults([{ callId: 'c1', name: 'mouse_click', content: [{ type: 'text', text: 'done' }, img] }]);
    const roles = s.messages.map((m) => m.role);
    expect(roles.slice(-2)).toEqual(['tool', 'user']);
  });

  it('reports invalid JSON arguments as a parse error', async () => {
    const { fetch } = mockFetch({
      choices: [{ message: { content: '', tool_calls: [{ id: 'c', function: { name: 'mouse_click', arguments: '{x:' } }] }, finish_reason: 'tool_calls' }],
    });
    const s = new OpenAiSession({ config: cfg('openrouter'), system: '', tools, fetchImpl: fetch });
    s.addUser([{ type: 'text', text: 't' }]);
    const turn = await s.next(new AbortController().signal);
    expect(turn.toolCalls[0].parseError).toBeDefined();
  });
});

describe('Gemini session', () => {
  it('sanitizes schemas, keeps model parts and sends functionResponse', async () => {
    expect(toGeminiSchema(tools[0].parameters)).toEqual({ type: 'object', properties: { x: { type: 'number' } }, required: ['x'] });
    const parts = [{ functionCall: { name: 'mouse_click', args: { x: 1 } }, thoughtSignature: 'sig' }];
    const { fetch, calls } = mockFetch({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
    const s = new GeminiSession({ config: cfg('gemini', { model: 'gemini-x' }), system: 'SYS', tools, fetchImpl: fetch });
    s.addUser([{ type: 'text', text: 't' }, img]);
    const turn = await s.next(new AbortController().signal);
    expect(calls[0].url).toContain('/models/gemini-x:generateContent');
    expect(turn.toolCalls[0].name).toBe('mouse_click');
    s.addToolResults([{ callId: turn.toolCalls[0].id, name: 'mouse_click', content: [{ type: 'text', text: 'ok' }] }]);
    expect(s.contents[1].parts[0].thoughtSignature).toBe('sig');
    expect(s.contents[2].parts[0].functionResponse.name).toBe('mouse_click');
  });
});

describe('JSON fallback (no native tool calling)', () => {
  it('parses fenced and bare JSON tool calls', () => {
    expect(parseJsonToolCall('次にクリック\n```json\n{"tool":"mouse_click","args":{"x":1}}\n```').call).toEqual({
      name: 'mouse_click',
      args: { x: 1 },
    });
    expect(parseJsonToolCall('{"tool": "wait", "args": {"seconds": 1}}').call?.name).toBe('wait');
    expect(parseJsonToolCall('完了しました').call).toBeNull();
    expect(parseJsonToolCall('```json\n{bad}\n```').error).toBeDefined();
  });

  it('is used automatically when supportsTools=false', async () => {
    const { fetch, calls } = mockFetch({ choices: [{ message: { content: '```json\n{"tool":"wait","args":{"seconds":1}}\n```' }, finish_reason: 'stop' }] });
    const s = createSession({ config: cfg('local', { supportsTools: false, endpoint: 'http://localhost:11434/v1' }), system: 'S', tools, fetchImpl: fetch });
    expect(s).toBeInstanceOf(JsonToolSession);
    s.addUser([{ type: 'text', text: 't' }]);
    const turn = await s.next(new AbortController().signal);
    expect(turn.toolCalls[0].name).toBe('wait');
    const req = JSON.parse(String(calls[0].init.body));
    expect(req.tools).toBeUndefined();
    expect(req.messages[0].content).toContain('Tool protocol');
  });
});

describe('config validation', () => {
  it('requires model, key, and https for remote hosts', () => {
    expect(validateConfig(cfg('anthropic'))).toBeNull();
    expect(validateConfig(cfg('anthropic', { model: '' }))).toMatch(/モデル/);
    expect(validateConfig(cfg('anthropic', { apiKey: '' }))).toMatch(/API キー/);
    expect(validateConfig(cfg('openai-compatible', { endpoint: 'http://example.com/v1', apiKey: '' }))).toMatch(/http/);
    expect(validateConfig(cfg('local', { endpoint: 'http://localhost:11434/v1', apiKey: '' }))).toBeNull();
  });
});

describe('HTTP retry', () => {
  it('retries 429 and succeeds; does not leak the key in errors', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '0.01' } });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await requestJson({ url: 'https://x', headers: {}, body: {}, signal: new AbortController().signal, maxRetries: 2, fetchImpl });
    expect(r).toEqual({ ok: true });
    expect(n).toBe(2);

    const failing = (async () => new Response('{"error":{"message":"bad key secret-key-1234567890"}}', { status: 401 })) as unknown as typeof fetch;
    const err = await requestJson({
      url: 'https://x',
      headers: { authorization: 'Bearer secret-key-1234567890' },
      body: {},
      signal: new AbortController().signal,
      maxRetries: 3,
      fetchImpl: failing,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).not.toContain('secret-key-1234567890');
    expect(err.status).toBe(401);
  });

  it('explains insufficient balance (402) clearly', async () => {
    const fetchImpl = (async () => new Response('{"error":{"message":"Insufficient balance"}}', { status: 402 })) as unknown as typeof fetch;
    const err = await requestJson({ url: 'https://x', headers: {}, body: {}, signal: new AbortController().signal, maxRetries: 2, fetchImpl }).catch((e) => e);
    expect(err.message).toContain('残高');
    expect(err.retryable).toBe(false);
  });

  it('aborts immediately', async () => {
    const ctrl = new AbortController();
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const p = requestJson({ url: 'https://x', headers: {}, body: {}, signal: ctrl.signal, maxRetries: 3, fetchImpl });
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });
});
