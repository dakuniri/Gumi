/**
 * Anthropic Messages API (Claude)。
 * ツール結果には画像ブロックを直接含められるため、操作後のスクリーンショットを tool_result に添付する。
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

type Block = Record<string, any>;
interface Message {
  role: 'user' | 'assistant';
  content: Block[];
}

export function toAnthropicContent(parts: ContentPart[]): Block[] {
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } },
  );
}

export class AnthropicSession implements ChatSession {
  readonly messages: Message[] = [];

  constructor(private readonly init: SessionInit) {}

  private pushUserBlocks(blocks: Block[]) {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'user') last.content.push(...blocks);
    else this.messages.push({ role: 'user', content: blocks });
  }

  addUser(parts: ContentPart[]): void {
    this.pushUserBlocks(toAnthropicContent(parts));
  }

  addToolResults(results: ToolResultMessage[]): void {
    // tool_result は tool_use 直後のユーザーメッセージの先頭に置く必要がある
    this.pushUserBlocks(
      results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.callId,
        content: toAnthropicContent(r.content),
        ...(r.isError ? { is_error: true } : {}),
      })),
    );
  }

  async next(signal: AbortSignal): Promise<ModelTurn> {
    const { config, system, tools } = this.init;
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: this.messages,
    };
    if (config.temperature !== null) body.temperature = config.temperature;
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    const res = await requestJson<{
      content: Block[];
      stop_reason: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>({
      url: joinUrl(config.endpoint || 'https://api.anthropic.com', 'v1/messages'),
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
      body,
      signal,
      maxRetries: config.maxRetries,
      fetchImpl: this.init.fetchImpl,
    });
    const content = Array.isArray(res.content) ? res.content : [];
    // 応答ブロックはそのまま履歴へ (thinking ブロック等も保持)
    this.messages.push({ role: 'assistant', content });
    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('\n')
      .trim();
    const toolCalls = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: String(b.id), name: String(b.name), args: b.input ?? {} }));
    return {
      text,
      toolCalls,
      stopReason: res.stop_reason ?? 'unknown',
      usage: { inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens },
    };
  }

  pruneImages(keep: number): void {
    let seen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== 'user') continue;
      for (let j = m.content.length - 1; j >= 0; j--) {
        const b = m.content[j];
        if (b.type === 'image') {
          seen++;
          if (seen > keep) m.content[j] = { type: 'text', text: IMAGE_PLACEHOLDER };
        } else if (b.type === 'tool_result' && Array.isArray(b.content)) {
          for (let k = b.content.length - 1; k >= 0; k--) {
            if (b.content[k].type === 'image') {
              seen++;
              if (seen > keep) b.content[k] = { type: 'text', text: IMAGE_PLACEHOLDER };
            }
          }
        }
      }
    }
  }
}
