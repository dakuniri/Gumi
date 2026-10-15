import type { ProviderId } from '../settings/schema';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png'; data: string };

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  /** 引数 JSON の解析に失敗した場合のエラー */
  parseError?: string;
}

export interface ToolResultMessage {
  callId: string;
  name: string;
  content: ContentPart[];
  isError?: boolean;
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  endpoint: string;
  apiKey: string;
  maxTokens: number;
  temperature: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  maxRetries: number;
}

/**
 * プロバイダー固有の会話履歴を保持するセッション。
 * 各プロバイダーのネイティブ形式をそのまま保持することで、
 * thinking ブロックや thought signature などを正しく往復させる。
 */
export interface ChatSession {
  addUser(parts: ContentPart[]): void;
  addToolResults(results: ToolResultMessage[]): void;
  next(signal: AbortSignal): Promise<ModelTurn>;
  /** 直近 keep 枚を残して古い画像を履歴から取り除く (トークン節約) */
  pruneImages(keep: number): void;
}

export interface SessionInit {
  config: ProviderConfig;
  system: string;
  tools: ToolSpec[];
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const IMAGE_PLACEHOLDER = '[older screenshot removed to save context]';
