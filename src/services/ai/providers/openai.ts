/**
 * OpenAI Chat Completions 互換 API (OpenAI / OpenRouter / OpenAI 互換サーバー / Ollama・LM Studio 等のローカル LLM)。
 * tool ロールのメッセージは画像を含められないため、画像はツール結果の直後に user メッセージとして添付する。
 */
import { APP_NAME, PROJECT_URL } from '../../app-info';
import { requestJson, joinUrl } from '../http';
import {
  IMAGE_PLACEHOLDER,
  type ChatSession,
  type ContentPart,
  type ModelTurn,
  type SessionInit,
  type ToolResultMessage,
} from '../types';

type Msg = Record<string, any>;

function toOpenAiContent(parts: ContentPart[]): Msg[] {
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } },
  );
}

export class OpenAiSession implements ChatSession {
  readonly messages: Msg[] = [];

  constructor(private readonly init: SessionInit) {
    this.messages.push({ role: 'system', content: init.system });
  }

  addUser(parts: ContentPart[]): void {
    const last = this.messages[this.messages.length - 1];
    const content = toOpenAiContent(parts);
    if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(...content);
    else this.messages.push({ role: 'user', content });
  }

  addToolResults(results: ToolResultMessage[]): void {
    const images: ContentPart[] = [];
    for (const r of results) {
      const text = r.content
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      const imgs = r.content.filter((p) => p.type === 'image');
      images.push(...imgs);
      this.messages.push({
        role: 'tool',
        tool_call_id: r.callId,
        content: (r.isError ? '[ERROR] ' : '') + (text || 'OK') + (imgs.length ? '\n(Screenshot attached in the next message.)' : ''),
      });
    }
    if (images.length > 0) {
      this.messages.push({
        role: 'user',
        content: [{ type: 'text', text: 'Screenshot after the action:' }, ...toOpenAiContent(images)],
      });
    }
  }

  private headers(): Record<string, string> {
    const { config } = this.init;
    const h: Record<string, string> = {};
    if (config.apiKey) h.authorization = `Bearer ${config.apiKey}`;
    if (config.provider === 'openrouter') {
      // OpenRouter のランキング・利用状況に表示されるアプリ情報
      h['HTTP-Referer'] = PROJECT_URL;
      h['X-Title'] = APP_NAME;
    }
    return h;
  }

  async next(signal: AbortSignal): Promise<ModelTurn> {
    const { config, tools } = this.init;
    const body: Record<string, unknown> = {
      model: config.model,
      messages: this.messages,
    };
    // OpenAI 本家は max_completion_tokens、互換サーバーは max_tokens が一般的
    if (config.provider === 'openai') body.max_completion_tokens = config.maxTokens;
    else body.max_tokens = config.maxTokens;
    if (config.temperature !== null) body.temperature = config.temperature;
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    const res = await requestJson<any>({
      url: joinUrl(config.endpoint, 'chat/completions'),
      headers: this.headers(),
      body,
      signal,
      maxRetries: config.maxRetries,
      fetchImpl: this.init.fetchImpl,
    });
    if (res?.error) throw new Error(`AI API エラー: ${res.error.message ?? JSON.stringify(res.error)}`);
    const choice = res?.choices?.[0];
    const msg = choice?.message ?? {};
    const toolCallsRaw: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const assistant: Msg = { role: 'assistant', content: msg.content ?? null };
    if (toolCallsRaw.length > 0) assistant.tool_calls = toolCallsRaw;
    this.messages.push(assistant);

    const toolCalls = toolCallsRaw.map((tc, i) => {
      const id = String(tc.id ?? `call_${Date.now()}_${i}`);
      if (!tc.id) tc.id = id;
      const name = String(tc.function?.name ?? '');
      const rawArgs = tc.function?.arguments;
      if (rawArgs && typeof rawArgs === 'object') return { id, name, args: rawArgs };
      try {
        return { id, name, args: rawArgs ? JSON.parse(String(rawArgs)) : {} };
      } catch {
        return { id, name, args: {}, parseError: `Arguments are not valid JSON: ${String(rawArgs).slice(0, 200)}` };
      }
    });
    const text = typeof msg.content === 'string' ? msg.content.trim() : Array.isArray(msg.content) ? msg.content.map((c: any) => c.text ?? '').join('') : '';
    return {
      text,
      toolCalls,
      stopReason: String(choice?.finish_reason ?? 'unknown'),
      usage: { inputTokens: res?.usage?.prompt_tokens, outputTokens: res?.usage?.completion_tokens },
    };
  }

  pruneImages(keep: number): void {
    let seen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (let j = m.content.length - 1; j >= 0; j--) {
        if (m.content[j].type === 'image_url') {
          seen++;
          if (seen > keep) m.content[j] = { type: 'text', text: IMAGE_PLACEHOLDER };
        }
      }
    }
  }
}
