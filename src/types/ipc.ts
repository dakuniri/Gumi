/**
 * Main と Renderer の IPC 契約。
 * Renderer は preload が公開する `window.gumi` だけを通じて Main と通信する。
 */
import type { PublicSettings, SettingsPatch, ProviderId, Corner } from '../services/settings/schema';
import type { AgentStatus, LogEntry, TaskRecord, TaskSummary } from './agent';
import type { CharacterState } from './character';
import type { BubbleAction } from '../services/layout/bubbles';
import type { PermissionStatus } from '../services/automation/types';

export type { PermissionStatus };

export interface InitialState {
  settings: PublicSettings;
  agent: AgentStatus;
  character: CharacterState;
  version: string;
  /** 実行中の OS */
  platform: 'win32' | 'darwin';
  /** PC 操作エンジン (Windows: Win32 / macOS: CoreGraphics + アクセシビリティ) が利用可能か */
  automationAvailable: boolean;
  automationError: string | null;
  shortcutErrors: string[];
}

export interface ModelInfo {
  id: string;
  label?: string;
}

export type InteractionKind = 'hover' | 'click' | 'panel' | 'typing';

/** invoke (要求/応答) チャネル */
export interface InvokeMap {
  'app:get-initial-state': { args: []; result: InitialState };
  'app:quit': { args: []; result: void };
  'settings:update': { args: [SettingsPatch]; result: PublicSettings };
  'settings:reset': { args: []; result: PublicSettings };
  'settings:set-api-key': { args: [{ provider: ProviderId; key: string }]; result: PublicSettings };
  'settings:clear-api-key': { args: [{ provider: ProviderId }]; result: PublicSettings };
  'settings:test-connection': { args: [{ provider: ProviderId }]; result: { reply: string; ms: number } };
  'settings:list-models': { args: [{ provider: ProviderId }]; result: ModelInfo[] };
  'agent:start': { args: [{ text: string }]; result: { taskId: string } };
  'agent:pause': { args: []; result: boolean };
  'agent:resume': { args: []; result: boolean };
  'agent:stop': { args: []; result: boolean };
  'agent:approve': { args: [{ id: string; approved: boolean; remember: boolean }]; result: void };
  'agent:answer': { args: [{ id: string; text: string }]; result: void };
  'history:list': { args: []; result: TaskSummary[] };
  'history:get': { args: [{ id: string }]; result: TaskRecord | null };
  'history:operations': { args: []; result: LogEntry[] };
  'history:clear': { args: []; result: void };
  'window:open-settings': { args: [{ tab?: string }]; result: void };
  'character:move-to-corner': { args: [{ corner: Corner }]; result: void };
  'character:set-visible': { args: [{ visible: boolean }]; result: void };
  /** macOS の許可の状態 (Windows は null) */
  'system:permissions': { args: []; result: PermissionStatus | null };
  'system:request-permission': { args: [{ kind: 'accessibility' | 'screen' }]; result: PermissionStatus | null };
}

/** send (一方向) チャネル */
export interface SendMap {
  'character:pointer-down': Record<string, never>;
  'character:pointer-up': Record<string, never>;
  'character:interaction': { kind: InteractionKind };
  'character:bubble': { action: BubbleAction };
  'character:open-input': Record<string, never>;
  'character:close-input': Record<string, never>;
  'character:dismiss-result': Record<string, never>;
  'character:result-size': { height: number };
}

/** Main → Renderer イベント */
export interface EventMap {
  'settings:changed': PublicSettings;
  'agent:status': AgentStatus;
  'agent:log': LogEntry;
  'character:state': CharacterState;
  'settings:navigate': { tab: string };
}

export const INVOKE_CHANNELS = [
  'app:get-initial-state',
  'app:quit',
  'settings:update',
  'settings:reset',
  'settings:set-api-key',
  'settings:clear-api-key',
  'settings:test-connection',
  'settings:list-models',
  'agent:start',
  'agent:pause',
  'agent:resume',
  'agent:stop',
  'agent:approve',
  'agent:answer',
  'history:list',
  'history:get',
  'history:operations',
  'history:clear',
  'window:open-settings',
  'character:move-to-corner',
  'character:set-visible',
  'system:permissions',
  'system:request-permission',
] as const satisfies readonly (keyof InvokeMap)[];

export const SEND_CHANNELS = [
  'character:pointer-down',
  'character:pointer-up',
  'character:interaction',
  'character:bubble',
  'character:open-input',
  'character:close-input',
  'character:dismiss-result',
  'character:result-size',
] as const satisfies readonly (keyof SendMap)[];

export const EVENT_CHANNELS = [
  'settings:changed',
  'agent:status',
  'agent:log',
  'character:state',
  'settings:navigate',
] as const satisfies readonly (keyof EventMap)[];

export interface GumiApi {
  invoke<K extends keyof InvokeMap>(channel: K, ...args: InvokeMap[K]['args']): Promise<InvokeMap[K]['result']>;
  send<K extends keyof SendMap>(channel: K, payload: SendMap[K]): void;
  on<K extends keyof EventMap>(channel: K, listener: (payload: EventMap[K]) => void): () => void;
}

/** invoke の応答エンベロープ (Main 側の例外を Renderer に安全に伝える) */
export type InvokeEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };
