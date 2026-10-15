/**
 * IPC 引数の検証スキーマ。Renderer から届く値はすべてここで検証してから使う。
 */
import { z } from 'zod';
import { PROVIDER_IDS, cornerSchema } from '../../src/services/settings/schema';

/** 設定パッチ: プレーンオブジェクトで、大きさと深さを制限する (内容は SettingsStore が完全検証) */
export const settingsPatchSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length < 100_000, '設定データが大きすぎます')
  .refine((v) => depth(v) <= 6, '設定データの階層が深すぎます')
  .transform((v) => {
    const { apiKeys: _a, secureStorageAvailable: _s, ...rest } = v as Record<string, unknown>;
    return rest;
  });

function depth(v: unknown, d = 0): number {
  if (!v || typeof v !== 'object') return d;
  return Math.max(d + 1, ...Object.values(v as object).map((x) => depth(x, d + 1)));
}

const provider = z.enum(PROVIDER_IDS);

export const invokeSchemas = {
  'app:get-initial-state': z.tuple([]),
  'app:quit': z.tuple([]),
  'settings:update': z.tuple([settingsPatchSchema]),
  'settings:reset': z.tuple([]),
  'settings:set-api-key': z.tuple([z.object({ provider, key: z.string().min(1).max(500) })]),
  'settings:clear-api-key': z.tuple([z.object({ provider })]),
  'settings:test-connection': z.tuple([z.object({ provider })]),
  'settings:list-models': z.tuple([z.object({ provider })]),
  'agent:start': z.tuple([z.object({ text: z.string().min(1).max(8000) })]),
  'agent:pause': z.tuple([]),
  'agent:resume': z.tuple([]),
  'agent:stop': z.tuple([]),
  'agent:approve': z.tuple([z.object({ id: z.string().uuid(), approved: z.boolean(), remember: z.boolean() })]),
  'agent:answer': z.tuple([z.object({ id: z.string().uuid(), text: z.string().min(1).max(4000) })]),
  'history:list': z.tuple([]),
  'history:get': z.tuple([z.object({ id: z.string().uuid() })]),
  'history:operations': z.tuple([]),
  'history:clear': z.tuple([]),
  'window:open-settings': z.tuple([z.object({ tab: z.string().max(40).optional() })]),
  'character:move-to-corner': z.tuple([z.object({ corner: cornerSchema })]),
  'character:set-visible': z.tuple([z.object({ visible: z.boolean() })]),
  'system:permissions': z.tuple([]),
  'system:request-permission': z.tuple([z.object({ kind: z.enum(['accessibility', 'screen']) })]),
} as const;

export const sendSchemas = {
  'character:pointer-down': z.object({}),
  'character:pointer-up': z.object({}),
  'character:interaction': z.object({ kind: z.enum(['hover', 'click', 'panel', 'typing']) }),
  'character:bubble': z.object({ action: z.enum(['settings', 'color']) }),
  'character:open-input': z.object({}),
  'character:close-input': z.object({}),
  'character:dismiss-result': z.object({}),
  'character:result-size': z.object({ height: z.number().min(0).max(2000) }),
} as const;
