/**
 * プロバイダー選択とセッション生成、モデル一覧取得、接続テスト。
 */
import { AnthropicSession } from './providers/anthropic';
import { OpenAiSession } from './providers/openai';
import { GeminiSession } from './providers/gemini';
import { JsonToolSession, buildJsonProtocolPrompt } from './providers/json-fallback';
import { requestJson, joinUrl } from './http';
import type { ChatSession, ProviderConfig, SessionInit, ToolSpec } from './types';
import { PROVIDER_LABELS, type ProviderId } from '../settings/schema';

export function providerNeedsKey(provider: ProviderId): boolean {
  return provider !== 'local' && provider !== 'openai-compatible';
}

export function validateConfig(config: ProviderConfig): string | null {
  if (!config.model.trim()) return 'AI モデルが設定されていません。設定画面でモデル名を入力してください。';
  if (!config.endpoint.trim()) return 'API エンドポイントが設定されていません。';
  try {
    const u = new URL(config.endpoint);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'エンドポイントは http(s) URL で指定してください。';
    if (u.protocol === 'http:' && !isLocalHost(u.hostname)) {
      return '暗号化されていない http 接続はローカルホストのみ許可されています。https を使用してください。';
    }
  } catch {
    return 'エンドポイント URL が不正です。';
  }
  if (providerNeedsKey(config.provider) && !config.apiKey) {
    return `${PROVIDER_LABELS[config.provider]} の API キーが設定されていません。`;
  }
  return null;
}

export function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
}

function baseSession(init: SessionInit): ChatSession {
  switch (init.config.provider) {
    case 'anthropic':
      return new AnthropicSession(init);
    case 'gemini':
      return new GeminiSession(init);
    default:
      return new OpenAiSession(init);
  }
}

export function createSession(init: SessionInit): ChatSession {
  if (init.config.supportsTools || init.tools.length === 0) return baseSession(init);
  // ツール呼び出し非対応モデル: JSON プロトコルにフォールバック
  const system = `${init.system}\n\n${buildJsonProtocolPrompt(init.tools)}`;
  return new JsonToolSession(baseSession({ ...init, system, tools: [] }));
}

export interface ModelInfo {
  id: string;
  label?: string;
}

export async function listModels(config: ProviderConfig, signal: AbortSignal, fetchImpl?: typeof fetch): Promise<ModelInfo[]> {
  const common = { signal, maxRetries: 1, method: 'GET' as const, body: undefined, fetchImpl, timeoutMs: 20_000 };
  switch (config.provider) {
    case 'anthropic': {
      const res = await requestJson<any>({
        ...common,
        url: joinUrl(config.endpoint || 'https://api.anthropic.com', 'v1/models?limit=100'),
        headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
      });
      return (res.data ?? []).map((m: any) => ({ id: String(m.id), label: m.display_name }));
    }
    case 'gemini': {
      const res = await requestJson<any>({
        ...common,
        url: joinUrl(config.endpoint || 'https://generativelanguage.googleapis.com/v1beta', 'models?pageSize=200'),
        headers: { 'x-goog-api-key': config.apiKey },
      });
      return (res.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m: any) => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName }));
    }
    default: {
      const headers: Record<string, string> = {};
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const res = await requestJson<any>({ ...common, url: joinUrl(config.endpoint, 'models'), headers });
      const arr = Array.isArray(res) ? res : (res.data ?? res.models ?? []);
      return arr.map((m: any) => ({ id: String(m.id ?? m.name), label: m.name && m.name !== m.id ? String(m.name) : undefined }));
    }
  }
}

/** 最小限のリクエストで接続とモデルを確認する */
export async function testConnection(
  config: ProviderConfig,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; reply: string; ms: number }> {
  const err = validateConfig(config);
  if (err) throw new Error(err);
  const started = Date.now();
  const tools: ToolSpec[] = [];
  const session = createSession({
    config: { ...config, maxTokens: Math.min(config.maxTokens, 256), maxRetries: 0 },
    system: 'You are a connectivity check. Reply with the single word: OK',
    tools,
    fetchImpl,
  });
  session.addUser([{ type: 'text', text: 'ping' }]);
  const turn = await session.next(signal);
  return { ok: true, reply: turn.text.slice(0, 200) || '(空の応答)', ms: Date.now() - started };
}
