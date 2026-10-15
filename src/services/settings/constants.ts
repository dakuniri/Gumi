/**
 * 設定の定数 (zod に依存しないため Renderer からも軽量に参照できる)。
 */

export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'openai-compatible',
  'local',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI 互換 API',
  local: 'ローカル LLM サーバー',
};

export const PERMISSION_CATEGORIES = [
  'screenshot',
  'mouse',
  'keyboard',
  'uiAutomation',
  'appLaunch',
  'windowControl',
  'browser',
  'web',
  'clipboard',
  'fileRead',
  'fileWrite',
  'fileDelete',
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export const PERMISSION_LABELS: Record<PermissionCategory, string> = {
  screenshot: '画面キャプチャ',
  mouse: 'マウス操作',
  keyboard: 'キーボード操作',
  uiAutomation: 'UI 要素の取得・操作',
  appLaunch: 'アプリケーション起動',
  windowControl: 'ウィンドウ操作',
  browser: 'ブラウザで URL を開く',
  web: 'Web 検索 (DuckDuckGo, 本文取得は 1 回 3 サイトまで)',
  clipboard: 'クリップボード',
  fileRead: 'ファイル読み取り',
  fileWrite: 'ファイル作成・移動・書き込み',
  fileDelete: 'ファイル削除 (ごみ箱へ)',
};

export interface ProviderProfileDefaults {
  model: string;
  endpoint: string;
  supportsVision: boolean;
  supportsTools: boolean;
  maxTokens: number;
  temperature: number | null;
}

export const DEFAULT_PROFILES: Record<ProviderId, ProviderProfileDefaults> = {
  anthropic: {
    model: 'claude-sonnet-5-5',
    endpoint: 'https://api.anthropic.com',
    supportsVision: true,
    supportsTools: true,
    maxTokens: 4096,
    temperature: null,
  },
  openai: {
    model: '',
    endpoint: 'https://api.openai.com/v1',
    supportsVision: true,
    supportsTools: true,
    maxTokens: 4096,
    temperature: null,
  },
  gemini: {
    model: '',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    supportsVision: true,
    supportsTools: true,
    maxTokens: 4096,
    temperature: null,
  },
  openrouter: {
    model: '',
    endpoint: 'https://openrouter.ai/api/v1',
    supportsVision: true,
    supportsTools: true,
    maxTokens: 4096,
    temperature: null,
  },
  'openai-compatible': {
    model: '',
    endpoint: 'http://localhost:8000/v1',
    supportsVision: true,
    supportsTools: true,
    maxTokens: 4096,
    temperature: null,
  },
  local: {
    model: '',
    endpoint: 'http://localhost:11434/v1',
    supportsVision: false,
    supportsTools: true,
    maxTokens: 4096,
    temperature: null,
  },
};

