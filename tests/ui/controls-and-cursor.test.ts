import { paletteFor, themeOf } from '../../src/hooks/useTheme';
import { ColorChoice } from '../../src/components/ui/controls';
import { settingsSchema } from '../../src/services/settings/schema';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  BUTTON,
  PILL_WIDTH,
  chooseControlsDirection,
  chooseSide,
  controlsLayout,
  hitControl,
  horizontalReach,
  orbWindowSize,
  RESULT_MAX_HEIGHT,
  resultRect,
  type HitState,
} from '../../src/services/layout/controls';
import { resolveExpression } from '../../src/services/expressions/resolver';
import { GumiOrb } from '../../src/components/GumiOrb/GumiOrb';
import { OrbControls } from '../../src/components/OrbControls/OrbControls';
import { idleStatus } from '../../src/types/agent';
import { AiCursorIcon } from '../../src/pages/CursorPage';
import { CURSOR_HOTSPOT, CURSOR_WINDOW, chevronPoints } from '../../src/services/layout/ai-cursor';

const SIZE = 36;
const base: HitState = { mode: 'idle', side: 'left', controlsDir: 'up', bubblesOpen: false, bubbleDir: 'up' };

describe('input pill and buttons layout', () => {
  it('puts the pill left of the circle and the stop button left of the pill', () => {
    const l = controlsLayout(SIZE, 'left', 'up');
    expect(l.pill.cx + PILL_WIDTH / 2).toBeLessThan(-SIZE / 2);
    expect(l.inputStop.x).toBeLessThan(l.pill.cx - PILL_WIDTH / 2);
    expect(l.inputStop.y).toBe(0);
  });

  it('puts pause (left) and stop (right) above the circle while working', () => {
    const l = controlsLayout(SIZE, 'left', 'up');
    expect(l.taskPause.x).toBeLessThan(0);
    expect(l.taskStop.x).toBeGreaterThan(0);
    expect(l.taskPause.y).toBeLessThan(-SIZE / 2);
    expect(l.taskStop.y).toBe(l.taskPause.y);
    expect(controlsLayout(SIZE, 'left', 'down').taskStop.y).toBeGreaterThan(SIZE / 2);
  });

  it('mirrors to the right when there is no room on the left', () => {
    expect(chooseSide({ x: 1890, y: 500 }, SIZE, { x: 0, width: 1920 })).toBe('left');
    expect(chooseSide({ x: 30, y: 500 }, SIZE, { x: 0, width: 1920 })).toBe('right');
    const r = controlsLayout(SIZE, 'right', 'up');
    expect(r.pill.cx).toBeGreaterThan(0);
    expect(r.inputStop.x).toBeGreaterThan(r.pill.cx);
    expect(chooseControlsDirection({ x: 500, y: 20 }, SIZE, 0)).toBe('down');
    expect(chooseControlsDirection({ x: 500, y: 500 }, SIZE, 0)).toBe('up');
  });

  it('window is large enough for everything on both sides', () => {
    for (const size of [20, 36, 96]) {
      const w = orbWindowSize(size);
      expect(w.width / 2).toBeGreaterThanOrEqual(horizontalReach(size));
      expect(w.height / 2).toBeGreaterThanOrEqual(size / 2 + BUTTON);
    }
  });

  it('hit-tests only the parts visible in each mode', () => {
    const l = controlsLayout(SIZE, 'left', 'up');
    expect(hitControl({ x: 0, y: 0 }, SIZE, base)).toBe('orb');
    expect(hitControl({ x: l.pill.cx, y: 0 }, SIZE, base)).toBeNull();
    const input = { ...base, mode: 'input' as const };
    expect(hitControl({ x: l.pill.cx, y: 0 }, SIZE, input)).toBe('pill');
    expect(hitControl(l.inputStop, SIZE, input)).toBe('stop');
    expect(hitControl(l.taskStop, SIZE, input)).toBeNull();
    const task = { ...base, mode: 'task' as const };
    expect(hitControl(l.taskPause, SIZE, task)).toBe('pause');
    expect(hitControl(l.taskStop, SIZE, task)).toBe('stop');
    expect(hitControl({ x: l.pill.cx, y: 0 }, SIZE, task)).toBeNull();
    // 承認待ち・質問待ちのときは作業中でも入力欄の位置が押せる (入力前の停止ボタンは出ない)
    for (const prompt of ['approval', 'question'] as const) {
      const p = { ...task, prompt };
      expect(hitControl({ x: l.pill.cx, y: 0 }, SIZE, p)).toBe('pill');
      expect(hitControl(l.inputStop, SIZE, p)).toBeNull();
      expect(hitControl(l.taskStop, SIZE, p)).toBe('stop');
    }
  });
});

describe('orb marks', () => {
  const render = (state: Parameters<typeof GumiOrb>[0]['state']) =>
    renderToStaticMarkup(createElement(GumiOrb, { size: 36, state, bubbles: { open: false, direction: 'up' } }));

  it('shows a magnifier while searching and a check mark when done', () => {
    expect(render('searching')).toContain('orb-search');
    expect(render('success')).toContain('check-path');
    expect(render('thinking')).not.toMatch(/orb-search|check-path/);
  });

  it('shows approval buttons and the question inline next to the circle (no separate panel)', () => {
    const agent = {
      ...idleStatus(),
      phase: 'awaiting-approval' as const,
      pendingApproval: { id: 'a', tool: 'delete_path', category: 'fileDelete' as const, risk: 'high' as const, description: 'ごみ箱へ移動', details: '', reason: '削除します' },
    };
    const html = renderToStaticMarkup(
      createElement(OrbControls, { size: 36, ui: { mode: 'task', prompt: 'approval', result: null, side: 'left', controlsDir: 'up' }, agent }),
    );
    expect(html).toContain('pill side-left open');
    expect(html).toContain('>許可<');
    expect(html).toContain('>拒否<');
    expect(html).toContain('ごみ箱へ移動');
    expect(html).toContain('許可しますか');
    expect(html).toContain('注意: ');
    const q = renderToStaticMarkup(
      createElement(OrbControls, {
        size: 36,
        ui: { mode: 'task', prompt: 'question', result: null, side: 'left', controlsDir: 'up' },
        agent: { ...idleStatus(), phase: 'awaiting-input' as const, pendingQuestion: { id: 'q', question: 'どのファイル？' } },
      }),
    );
    expect(q).toContain('どのファイル？');
    expect(q).toContain('回答を入力');
  });

  it('shows the result (summary or failure reason) next to the circle and makes it clickable', () => {
    const html = renderToStaticMarkup(
      createElement(OrbControls, {
        size: 36,
        ui: { mode: 'idle', prompt: null, result: { kind: 'error', text: 'AI サービスの残高 (クレジット) が不足しています' }, side: 'left', controlsDir: 'up' },
        agent: { ...idleStatus(), phase: 'failed' as const },
      }),
    );
    expect(html).toContain('result-note error');
    expect(html).toContain('できませんでした');
    expect(html).toContain('残高');
    const st: HitState = { ...base, resultHeight: 60 };
    const r = resultRect(SIZE, 'left', 'up', 60);
    expect(r.x + r.width).toBeLessThan(-SIZE / 2);
    expect(r.y + r.height).toBe(17);
    expect(hitControl({ x: r.x + 10, y: r.y + 10 }, SIZE, st)).toBe('result');
    expect(hitControl({ x: r.x + 10, y: r.y + 10 }, SIZE, base)).toBeNull();
    expect(orbWindowSize(SIZE).height / 2).toBeGreaterThanOrEqual(RESULT_MAX_HEIGHT - 17);
  });

  it('resolves web_search as the searching state', () => {
    const i = {
      pendingApproval: false,
      pendingQuestion: false,
      sleeping: false,
      waking: false,
      hover: false,
      dragging: false,
      inputOpen: false,
      idle: false,
      reaction: null,
    };
    expect(resolveExpression({ ...i, phase: 'thinking', currentTool: 'web_search' })).toBe('searching');
    expect(resolveExpression({ ...i, phase: 'acting', currentTool: 'mouse_click' })).toBe('working');
    expect(resolveExpression({ ...i, phase: 'completed', reaction: 'success' })).toBe('success');
  });
});

describe('AI cursor ("<" shape pointing up-left)', () => {
  it('has its tip exactly on the hotspot at the top-left of the shape', () => {
    const pts = chevronPoints();
    expect(pts[0]).toEqual(CURSOR_HOTSPOT);
    for (const p of pts.slice(1)) {
      // 先端以外の点はすべて先端より右下にある = 先端が左上を向いている
      expect(p.x).toBeGreaterThan(CURSOR_HOTSPOT.x);
      expect(p.y).toBeGreaterThan(CURSOR_HOTSPOT.y);
    }
  });

  it('is symmetric about the 45-degree axis and fits in the window', () => {
    const [tip, p1, p1in, inner, p2in, p2] = chevronPoints();
    const mirror = (p: { x: number; y: number }) => ({ x: tip.x + (p.y - tip.y), y: tip.y + (p.x - tip.x) });
    expect(mirror(p1).x).toBeCloseTo(p2.x, 1);
    expect(mirror(p1).y).toBeCloseTo(p2.y, 1);
    expect(mirror(p1in).x).toBeCloseTo(p2in.x, 1);
    expect(inner.x - tip.x).toBeCloseTo(inner.y - tip.y, 1);
    for (const p of chevronPoints()) {
      expect(p.x).toBeLessThan(CURSOR_WINDOW - 2);
      expect(p.y).toBeLessThan(CURSOR_WINDOW - 2);
    }
  });

  it('uses the configured white / black colors', () => {
    const white = renderToStaticMarkup(createElement(AiCursorIcon, { color: 'white' }));
    expect(white).toContain('fill="#111111"');
    expect(white).toContain('stroke="#ffffff"');
    const black = renderToStaticMarkup(createElement(AiCursorIcon, { color: 'black' }));
    expect(black).toContain('fill="#ffffff"');
    expect(black).toContain('stroke="#111111"');
    const amu = renderToStaticMarkup(createElement(AiCursorIcon, { color: 'amu' }));
    expect(amu).toContain('fill="#279634"');
    expect(amu).toContain('stroke="#ffffff"');
  });

  it('offers 亜夢 (#279634) as a third color in settings only', () => {
    expect(paletteFor('amu')['--core-bg']).toBe('#279634');
    expect(settingsSchema.parse({ appearance: { color: 'amu' } }).appearance.color).toBe('amu');
    const html = renderToStaticMarkup(createElement(ColorChoice, { value: 'amu', onChange: () => undefined }));
    expect(html).toContain('亜夢');
  });

  it('keeps the 亜夢 circle green and switches the whole UI between white and black', () => {
    // 円そのものは緑に白の記号
    for (const tone of ['white', 'black'] as const) {
      expect(paletteFor('amu', tone)['--core-bg']).toBe('#279634');
      expect(paletteFor('amu', tone)['--core-fg']).toBe('#ffffff');
    }
    // 画面 (入力欄・小さな円・ボタン) は白 / 黒の配色と同じ
    const { ['--core-bg']: _a, ['--core-fg']: _b, ...amuWhite } = paletteFor('amu', 'white');
    const { ['--core-bg']: _c, ['--core-fg']: _d, ...white } = paletteFor('white');
    expect(amuWhite).toEqual(white);
    const { ['--core-bg']: _e, ['--core-fg']: _f, ...amuBlack } = paletteFor('amu', 'black');
    const { ['--core-bg']: _g, ['--core-fg']: _h, ...black } = paletteFor('black');
    expect(amuBlack).toEqual(black);
    expect(themeOf('amu', 'black')).toBe('dark');
    expect(themeOf('amu', 'white')).toBe('light');
    expect(settingsSchema.parse({}).appearance.amuTone).toBe('white');
    expect(settingsSchema.safeParse({ appearance: { amuTone: 'red' } }).success).toBe(false);
    const cursor = renderToStaticMarkup(createElement(AiCursorIcon, { color: 'amu', amuTone: 'black' }));
    expect(cursor).toContain('stroke="#111111"');
  });
});
