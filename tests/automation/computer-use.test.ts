import { describe, expect, it } from 'vitest';
import { createFrame, fitImageSize, imageToScreen, screenRectToImage, screenToImage } from '../../src/services/computer-use/coords';
import { availableTools, getTool, toJsonSchema, toolSpecs, validateToolCall } from '../../src/services/computer-use/tools';
import { decidePermission, type PermissionContext } from '../../src/services/computer-use/permissions';
import { matchBlockedKeyword, redactSecrets } from '../../src/services/computer-use/redact';
import { compareFingerprints } from '../../src/services/screenshots/diff';
import { defaultSettings, PERMISSION_CATEGORIES } from '../../src/services/settings/schema';

describe('coordinate mapping (DPI / multi-monitor)', () => {
  it('fits image size to the long edge', () => {
    expect(fitImageSize(3840, 2160, 1280)).toEqual({ width: 1280, height: 720 });
    expect(fitImageSize(800, 600, 1280)).toEqual({ width: 800, height: 600 });
  });

  it('maps image coordinates to physical pixels on a 150% secondary display at negative x', () => {
    const frame = createFrame({ x: -3840, y: 0, width: 3840, height: 2160 }, 1280, { id: 2, index: 1, scaleFactor: 1.5 });
    expect(frame.imageWidth).toBe(1280);
    expect(imageToScreen(frame, { x: 0, y: 0 })).toEqual({ x: -3840, y: 0 });
    expect(imageToScreen(frame, { x: 640, y: 360 })).toEqual({ x: -1920, y: 1080 });
    expect(screenToImage(frame, { x: -1920, y: 1080 })).toEqual({ x: 640, y: 360 });
    expect(screenRectToImage(frame, { x: -3840, y: 0, width: 300, height: 150 })).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it('maps a cropped active-window region', () => {
    const frame = createFrame({ x: 100, y: 200, width: 800, height: 600 }, 1280, { id: 1, index: 0, scaleFactor: 1 });
    expect(imageToScreen(frame, { x: 10, y: 20 })).toEqual({ x: 110, y: 220 });
  });
});

describe('tool definitions', () => {
  it('validates arguments and applies defaults', () => {
    const { args } = validateToolCall('mouse_click', { x: 10, y: 20 });
    expect(args).toMatchObject({ x: 10, y: 20, button: 'left', clicks: 1 });
    expect(() => validateToolCall('mouse_click', { x: 'a' })).toThrow(/Invalid arguments/);
    expect(() => validateToolCall('run_shell', {})).toThrow(/Unknown tool/);
  });

  it('produces clean JSON schemas', () => {
    const schema = toJsonSchema(getTool('mouse_click')!.schema);
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['x', 'y']);
    for (const spec of toolSpecs(availableTools({ vision: true, isDenied: () => false }))) {
      expect(JSON.stringify(spec.parameters)).not.toContain('9007199254740991');
    }
  });

  it('hides vision-only and denied tools', () => {
    const noVision = availableTools({ vision: false, isDenied: () => false }).map((t) => t.name);
    expect(noVision).not.toContain('screenshot');
    expect(noVision).toContain('get_ui_elements');
    const noFiles = availableTools({ vision: true, isDenied: (c) => c === 'fileDelete' }).map((t) => t.name);
    expect(noFiles).not.toContain('delete_path');
  });

  it('assesses risk from arguments', () => {
    // キー配列は実行中の OS のもの (macOS では win+r は cmd+r = 再読み込みで、危険ではない)
    const risky = process.platform === 'darwin' ? 'cmd+q' : 'win+r';
    const safe = process.platform === 'darwin' ? 'cmd+c' : 'ctrl+c';
    expect(getTool('press_keys')!.risk({ keys: risky, repeat: 1 } as never).level).toBe('high');
    expect(getTool('press_keys')!.risk({ keys: safe, repeat: 1 } as never).level).toBe('low');
    expect(getTool('launch_app')!.risk({ name: 'powershell' } as never).level).toBe('high');
    expect(getTool('write_text_file')!.risk({ path: 'x', content: '', overwrite: true } as never).level).toBe('high');
  });
});

describe('permissions', () => {
  const base = (): PermissionContext => ({
    permissions: { ...defaultSettings().permissions },
    confirmPolicy: 'high',
    approvedForTask: new Set(),
  });

  it('allows low risk, asks for high risk, denies disabled categories', () => {
    const click = getTool('mouse_click')!;
    expect(decidePermission(click, { level: 'low' }, base()).kind).toBe('allow');
    const del = getTool('delete_path')!;
    expect(decidePermission(del, { level: 'high' }, base())).toMatchObject({ kind: 'ask', rememberable: false });
    const ctx = base();
    ctx.permissions.mouse = 'deny';
    expect(decidePermission(click, { level: 'low' }, ctx).kind).toBe('deny');
  });

  it('respects confirmation policy and per-task approvals', () => {
    const launch = getTool('launch_app')!;
    expect(decidePermission(launch, { level: 'medium' }, base()).kind).toBe('allow');
    const ctx = base();
    ctx.confirmPolicy = 'medium';
    expect(decidePermission(launch, { level: 'medium' }, ctx).kind).toBe('ask');
    ctx.approvedForTask.add('launch_app');
    expect(decidePermission(launch, { level: 'medium' }, ctx).kind).toBe('allow');
    const every = base();
    every.confirmPolicy = 'every';
    expect(decidePermission(getTool('mouse_click')!, { level: 'low' }, every).kind).toBe('ask');
  });

  it('always asks for request_confirmation and category "ask"', () => {
    expect(decidePermission(getTool('request_confirmation')!, { level: 'high' }, base()).kind).toBe('ask');
    const ctx = base();
    ctx.permissions.keyboard = 'ask';
    expect(decidePermission(getTool('type_text')!, { level: 'low' }, ctx).kind).toBe('ask');
  });

  it('has a default mode for every category', () => {
    for (const c of PERMISSION_CATEGORIES) expect(['allow', 'ask', 'deny']).toContain(defaultSettings().permissions[c]);
  });
});

describe('secret redaction', () => {
  it('masks API keys, cards (Luhn) and passwords', () => {
    const r = redactSecrets('key sk-ant-abcdefghijklmnopqrstuvwxyz card 4111 1111 1111 1111 password: hunter2 order 1234567890123');
    expect(r.text).not.toContain('sk-ant-');
    expect(r.text).not.toContain('4111 1111');
    expect(r.text).not.toContain('hunter2');
    expect(r.text).toContain('1234567890123'); // Luhn 不一致は残す
    expect(r.redactions.length).toBeGreaterThanOrEqual(3);
  });

  it('matches blocked window keywords case-insensitively', () => {
    expect(matchBlockedKeyword('KeePass - Database', ['keepass'])).toBe('keepass');
    expect(matchBlockedKeyword('メモ帳', ['パスワード'])).toBeNull();
  });
});

describe('screen change detection', () => {
  it('detects changes but ignores tiny noise', () => {
    const a = new Uint8Array(64 * 36).fill(100);
    const b = a.slice();
    b[0] = 140; // 1 ピクセルだけ変化
    expect(compareFingerprints(a, b).changed).toBe(false);
    const c = a.map((v, i) => (i < 400 ? 200 : v));
    expect(compareFingerprints(a, c).changed).toBe(true);
    expect(compareFingerprints(null, a).changed).toBe(true);
  });
});
