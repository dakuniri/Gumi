/**
 * Google Gemini API (generateContent)。
 * モデル応答の parts (thoughtSignature を含む) はそのまま履歴に保持して返送する。
 */
import { requestJson, joinUrl } from '../http';
import {
  IMAGE_PLACEHOLDER,
  type ChatSession,
  type ContentPart,
  type ModelTurn,
  type SessionInit,
  type ToolResultMessage,
} from '../types';

type Part = Record<string, any>;
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'properties',
  'required',
  'items',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'anyOf',
]);

/** Gemini が受け付ける OpenAPI サブセットへ JSON Schema を変換する */
export function toGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (!ALLOWED_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else {
      out[k] = toGeminiSchema(v);
    }
  }
  return out;
}

function toParts(parts: ContentPart[]): Part[] {
  return parts.map((p) =>
    p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mediaType, data: p.data } },
  );
}

export class GeminiSession implements ChatSession {
  readonly contents: Content[] = [];

  constructor(private readonly init: SessionInit) {}

  private pushUser(parts: Part[]) {
    const last = this.contents[this.contents.length - 1];
    if (last && last.role === 'user') last.parts.push(...parts);
    else this.contents.push({ role: 'user', parts });
  }

  addUser(parts: ContentPart[]): void {
    this.pushUser(toParts(parts));
  }

  addToolResults(results: ToolResultMessage[]): void {
    const responses: Part[] = [];
    const images: Part[] = [];
    for (const r of results) {
      const text = r.content
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      responses.push({
        functionResponse: {
          ...(r.callId && !r.callId.startsWith('gemini_') ? { id: r.callId } : {}),
          name: r.name,
          response: r.isError ? { error: text } : { result: text || 'OK' },
        },
      });
      images.push(...toParts(r.content.filter((p) => p.type === 'image')));
    }
    this.pushUser([...responses, ...images]);
  }

  async next(signal: AbortSignal): Promise<ModelTurn> {
    const { config, system, tools } = this.init;
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: system }] },
      contents: this.contents,
      generationConfig: {
        maxOutputTokens: config.maxTokens,
        ...(config.temperature !== null ? { temperature: config.temperature } : {}),
      },
    };
    if (tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: toGeminiSchema(t.parameters),
          })),
        },
      ];
    }
    const model = config.model.replace(/^models\//, '');
    const res = await requestJson<any>({
      url: joinUrl(config.endpoint || 'https://generativelanguage.googleapis.com/v1beta', `models/${encodeURIComponent(model)}:generateContent`),
      headers: { 'x-goog-api-key': config.apiKey },
      body,
      signal,
      maxRetries: config.maxRetries,
      fetchImpl: this.init.fetchImpl,
    });
    const cand = res?.candidates?.[0];
    if (!cand) {
      const reason = res?.promptFeedback?.blockReason;
      throw new Error(reason ? `Gemini が応答を拒否しました (${reason})` : 'Gemini から応答がありませんでした');
    }
    const parts: Part[] = cand.content?.parts ?? [];
    this.contents.push({ role: 'model', parts });
    const text = parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: String(p.functionCall.id ?? `gemini_${Date.now()}_${i}`),
        name: String(p.functionCall.name),
        args: p.functionCall.args ?? {},
      }));
    return {
      text,
      toolCalls,
      stopReason: String(cand.finishReason ?? 'unknown'),
      usage: {
        inputTokens: res?.usageMetadata?.promptTokenCount,
        outputTokens: res?.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  pruneImages(keep: number): void {
    let seen = 0;
    for (let i = this.contents.length - 1; i >= 0; i--) {
      const c = this.contents[i];
      if (c.role !== 'user') continue;
      for (let j = c.parts.length - 1; j >= 0; j--) {
        if (c.parts[j].inlineData) {
          seen++;
          if (seen > keep) c.parts[j] = { text: IMAGE_PLACEHOLDER };
        }
      }
    }
  }
}
