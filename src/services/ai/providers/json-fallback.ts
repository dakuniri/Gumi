/**
 * ツール呼び出し (function calling) に対応していないモデル向けのフォールバック。
 * ツール一覧をシステムプロンプトに埋め込み、モデルには JSON で 1 つの操作を出力させる。
 */
import type { ChatSession, ContentPart, ModelTurn, ToolCall, ToolResultMessage, ToolSpec } from '../types';

export function buildJsonProtocolPrompt(tools: ToolSpec[]): string {
  const list = tools
    .map((t) => `- ${t.name}: ${t.description}\n  args schema: ${JSON.stringify(t.parameters)}`)
    .join('\n');
  return [
    '## Tool protocol (this model has no native tool calling)',
    'To perform an action, reply with exactly ONE JSON object inside a ```json code block:',
    '```json',
    '{"tool": "<tool name>", "args": { ... }}',
    '```',
    'You may write a short explanation before the code block. Only one tool per reply.',
    'The result of the tool will be sent back to you as the next user message.',
    'When the task is finished, call the task_complete tool.',
    '',
    'Available tools:',
    list,
  ].join('\n');
}

/** モデル出力テキストから JSON のツール呼び出しを取り出す */
export function parseJsonToolCall(text: string): { call: { name: string; args: unknown } | null; error?: string; rest: string } {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  let candidate = fence?.[1];
  if (!candidate) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start && /"tool"\s*:/.test(text)) candidate = text.slice(start, end + 1);
  }
  if (!candidate) return { call: null, rest: text.trim() };
  const rest = (fence ? text.replace(fence[0], '') : text.replace(candidate, '')).trim();
  try {
    const obj = JSON.parse(candidate.trim());
    const name = obj.tool ?? obj.name ?? obj.function;
    if (typeof name !== 'string') return { call: null, error: 'JSON に "tool" がありません', rest };
    return { call: { name, args: obj.args ?? obj.arguments ?? obj.parameters ?? {} }, rest };
  } catch (err) {
    return { call: null, error: `JSON を解析できません: ${(err as Error).message}`, rest };
  }
}

export class JsonToolSession implements ChatSession {
  private counter = 0;

  constructor(private readonly inner: ChatSession) {}

  addUser(parts: ContentPart[]): void {
    this.inner.addUser(parts);
  }

  addToolResults(results: ToolResultMessage[]): void {
    const parts: ContentPart[] = [];
    for (const r of results) {
      parts.push({ type: 'text', text: `Tool result for ${r.name}${r.isError ? ' (ERROR)' : ''}:` });
      parts.push(...r.content);
    }
    this.inner.addUser(parts);
  }

  async next(signal: AbortSignal): Promise<ModelTurn> {
    const turn = await this.inner.next(signal);
    const parsed = parseJsonToolCall(turn.text);
    const toolCalls: ToolCall[] = [];
    if (parsed.call) {
      toolCalls.push({ id: `json_${++this.counter}`, name: parsed.call.name, args: parsed.call.args });
    } else if (parsed.error) {
      toolCalls.push({ id: `json_${++this.counter}`, name: 'invalid_json', args: {}, parseError: parsed.error });
    }
    return { ...turn, text: parsed.rest, toolCalls };
  }

  pruneImages(keep: number): void {
    this.inner.pruneImages(keep);
  }
}
