import { z } from 'zod';
import {
  DEFAULT_PROFILES,
  PERMISSION_CATEGORIES,
  PROVIDER_IDS,
  type PermissionCategory,
  type ProviderId,
} from './constants';

export * from './constants';

/**
 * Gumi の設定スキーマ (Main Process で検証・永続化される)。
 * Renderer には API キーを除いた {@link PublicSettings} のみが渡される。
 */

export const permissionModeSchema = z.enum(['allow', 'ask', 'deny']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const cornerSchema = z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
export type Corner = z.infer<typeof cornerSchema>;

export const providerProfileSchema = z.object({
  model: z.string().max(200).default(''),
  endpoint: z.string().max(500).default(''),
  supportsVision: z.boolean().default(true),
  supportsTools: z.boolean().default(true),
  maxTokens: z.number().int().min(256).max(64000).default(4096),
  temperature: z.number().min(0).max(2).nullable().default(null),
});
export type ProviderProfile = z.infer<typeof providerProfileSchema>;

const profilesSchema = z.object(
  Object.fromEntries(
    PROVIDER_IDS.map((id) => [id, providerProfileSchema.default(DEFAULT_PROFILES[id])]),
  ) as Record<ProviderId, z.ZodDefault<typeof providerProfileSchema>>,
);

const permissionsSchema = z.object(
  Object.fromEntries(
    PERMISSION_CATEGORIES.map((c) => [c, permissionModeSchema.default(defaultPermission(c))]),
  ) as Record<PermissionCategory, z.ZodDefault<typeof permissionModeSchema>>,
);

function defaultPermission(c: PermissionCategory): PermissionMode {
  switch (c) {
    case 'fileDelete':
      return 'ask';
    case 'clipboard':
    case 'fileWrite':
    case 'appLaunch':
    case 'browser':
      return 'allow';
    default:
      return 'allow';
  }
}

export const settingsSchema = z.object({
  version: z.literal(3).default(3),
  ai: z
    .object({
      provider: z.enum(PROVIDER_IDS).default('anthropic'),
      profiles: profilesSchema.default(DEFAULT_PROFILES),
      /** 「一覧を取得」で取得したモデル名 (プロバイダーごと) */
      modelCache: z
        .record(
          z.string(),
          z.object({ ids: z.array(z.string().max(200)).max(500), fetchedAt: z.number() }),
        )
        .default({}),
    })
    .default({ provider: 'anthropic', profiles: DEFAULT_PROFILES, modelCache: {} }),
  agent: z
    .object({
      maxSteps: z.number().int().min(1).max(300).default(50),
      speed: z.enum(['slow', 'normal', 'fast']).default('normal'),
      autoRetry: z.boolean().default(true),
      maxApiRetries: z.number().int().min(0).max(10).default(3),
      maxActionRetries: z.number().int().min(0).max(10).default(3),
      screenshotAfterAction: z.boolean().default(true),
      keepScreenshots: z.number().int().min(1).max(10).default(3),
      textInputMethod: z.enum(['auto', 'unicode', 'clipboard']).default('auto'),
      pauseOnUserInput: z.boolean().default(true),
    })
    .default({
      maxSteps: 50,
      speed: 'normal',
      autoRetry: true,
      maxApiRetries: 3,
      maxActionRetries: 3,
      screenshotAfterAction: true,
      keepScreenshots: 3,
      textInputMethod: 'auto',
      pauseOnUserInput: true,
    }),
  permissions: permissionsSchema.default(
    Object.fromEntries(PERMISSION_CATEGORIES.map((c) => [c, defaultPermission(c)])) as Record<
      PermissionCategory,
      PermissionMode
    >,
  ),
  /** 確認ポリシー: どのリスクレベル以上で承認を求めるか ('high' でも高リスク操作は必ず確認) */
  confirmPolicy: z.enum(['every', 'medium', 'high']).default('high'),
  screenshot: z
    .object({
      scope: z.enum(['cursor-display', 'primary-display', 'active-window']).default('cursor-display'),
      maxLongEdge: z.number().int().min(640).max(2560).default(1280),
      jpegQuality: z.number().int().min(40).max(100).default(80),
      /** AI の撮影に Gumi を写さない (撮影の間だけキャプチャから除外。画面上では消えない) */
      hideGumiDuringCapture: z.boolean().default(true),
      blockedWindowKeywords: z
        .array(z.string().max(100))
        .max(100)
        .default(['パスワード', 'password', '1Password', 'KeePass', 'Bitwarden', '暗証番号']),
      redactSecrets: z.boolean().default(true),
    })
    .default({
      scope: 'cursor-display',
      maxLongEdge: 1280,
      jpegQuality: 80,
      hideGumiDuringCapture: true,
      blockedWindowKeywords: ['パスワード', 'password', '1Password', 'KeePass', 'Bitwarden', '暗証番号'],
      redactSecrets: true,
    }),
  appearance: z
    .object({
      /** 円と UI の配色 (白 / 黒 / 亜夢)。amu = 亜夢 (#279634) は設定画面からだけ選べる */
      color: z.enum(['white', 'black', 'amu']).default('white'),
      /** 亜夢のときの画面 (入力欄・小さな円・ボタン・設定画面) の配色 (白 / 黒) */
      amuTone: z.enum(['white', 'black']).default('white'),
      /** 状態を示すアニメーション */
      animations: z.boolean().default(true),
      /** AI が動かしているカーソルの位置に「<」の形のカーソルを表示する */
      aiCursor: z.boolean().default(true),
    })
    .default({ color: 'white', amuTone: 'white', animations: true, aiCursor: true }),
  character: z
    .object({
      size: z.number().int().min(20).max(96).default(36),
      visible: z.boolean().default(true),
      alwaysOnTop: z.boolean().default(true),
      startPosition: z.enum(['last', 'top-left', 'top-right', 'bottom-left', 'bottom-right']).default('last'),
      snapToEdges: z.boolean().default(true),
      /** 円の中心 (DIP, 仮想スクリーン座標) */
      position: z
        .object({ x: z.number(), y: z.number(), displayId: z.number().nullable() })
        .nullable()
        .default(null),
      sleepEnabled: z.boolean().default(true),
      sleepAfterSec: z.number().int().min(10).max(3600).default(120),
    })
    .default({
      size: 36,
      visible: true,
      alwaysOnTop: true,
      startPosition: 'last',
      snapToEdges: true,
      position: null,
      sleepEnabled: true,
      sleepAfterSec: 120,
    }),
  system: z
    .object({
      launchAtLogin: z.boolean().default(false),
      emergencyStopShortcut: z.string().max(60).default('Control+Alt+Escape'),
      pauseShortcut: z.string().max(60).default('Control+Alt+P'),
    })
    .default({
      launchAtLogin: false,
      emergencyStopShortcut: 'Control+Alt+Escape',
      pauseShortcut: 'Control+Alt+P',
    }),
  history: z
    .object({
      enabled: z.boolean().default(true),
      maxTasks: z.number().int().min(1).max(2000).default(200),
    })
    .default({ enabled: true, maxTasks: 200 }),
});

export type Settings = z.infer<typeof settingsSchema>;

export type ApiKeyStatus = Record<ProviderId, boolean>;

/** Renderer に公開される設定 (秘密情報は含まない) */
export interface PublicSettings extends Settings {
  apiKeys: ApiKeyStatus;
  secureStorageAvailable: boolean;
}

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
export type SettingsPatch = DeepPartial<Settings>;

/** 配列以外のオブジェクトを再帰的にマージする */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (
    patch === null ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    base === null ||
    typeof base !== 'object' ||
    Array.isArray(base)
  ) {
    return patch as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = deepMerge(out[k], v);
  }
  return out as T;
}

/**
 * 永続化された (古い/壊れた可能性のある) 設定を読み込み、検証済みの設定を返す。
 * 不正なフィールドはデフォルト値に戻す。
 */
export function migrateSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  const input = { ...(raw as Record<string, unknown>) };
  const version = typeof input.version === 'number' ? input.version : 1;
  if (version < 2) {
    // v1 -> v2: 初期の顔のデザインから白黒の小さな円へ変更。大きさと配色は新しい既定値を使う
    const character = { ...((input.character as Record<string, unknown>) ?? {}) };
    delete character.size;
    input.character = character;
    delete input.appearance;
    delete input.expressions;
  }
  if (version < 3) {
    // v2 -> v3: キャプチャ除外 (画面共有・スクショにも映らなくなる) を廃止し、AI の撮影時だけ隠す方式へ
    const screenshot = { ...((input.screenshot as Record<string, unknown>) ?? {}) };
    delete screenshot.excludeGumi;
    screenshot.hideGumiDuringCapture = true;
    input.screenshot = screenshot;
  }
  input.version = 3;
  const merged = deepMerge(base, input);
  const parsed = settingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // フィールド単位で修復: 問題のあるパスをデフォルトへ戻して再検証
  let repaired: unknown = merged;
  for (const issue of parsed.error.issues) {
    repaired = resetPath(repaired, issue.path as (string | number)[], base);
  }
  const second = settingsSchema.safeParse(repaired);
  return second.success ? second.data : base;
}

function resetPath(obj: unknown, path: (string | number)[], defaults: unknown): unknown {
  if (path.length === 0) return defaults;
  if (!obj || typeof obj !== 'object') return defaults;
  const [head, ...rest] = path;
  const defChild =
    defaults && typeof defaults === 'object' ? (defaults as Record<string | number, unknown>)[head] : undefined;
  const copy: Record<string | number, unknown> = Array.isArray(obj)
    ? ([...obj] as unknown as Record<number, unknown>)
    : { ...(obj as Record<string, unknown>) };
  if (rest.length === 0) {
    if (defChild === undefined) delete copy[head];
    else copy[head] = defChild;
    return Array.isArray(obj) ? Object.values(copy) : copy;
  }
  copy[head] = resetPath(copy[head], rest, defChild);
  return copy;
}
