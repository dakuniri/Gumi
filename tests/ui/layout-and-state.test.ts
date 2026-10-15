import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  clampFaceCenter,
  cornerCenter,
  cornerOf,
  snapFaceCenter,
} from '../../src/services/layout/placement';
import { BUTTON, controlsLayout, orbExtent } from '../../src/services/layout/controls';
import { bubbleDirection, bubbleGeometry, bubbleOffsets, hitBubble, inBubbleCorridor } from '../../src/services/layout/bubbles';
import { reactionForPhase, resolveExpression, type ExpressionInputs } from '../../src/services/expressions/resolver';
import { paletteFor } from '../../src/hooks/useTheme';
import { GumiOrb } from '../../src/components/GumiOrb/GumiOrb';

const work = { x: 0, y: 0, width: 1920, height: 1040 };
const SIZE = 36;

describe('corners and clamping', () => {
  // 円の中心から、作業中のボタン・小さな円・リングが広がる範囲
  const ext = orbExtent(SIZE);

  it('places the circle in each corner inside the work area', () => {
    expect(cornerCenter('bottom-right', SIZE, work)).toEqual({ x: 1920 - ext.x - 2, y: 1040 - 12 - 18 });
    expect(cornerCenter('top-left', SIZE, work)).toEqual({ x: ext.x + 2, y: 30 });
    expect(cornerOf({ x: 1890, y: 1010 }, work)).toBe('bottom-right');
    expect(cornerOf({ x: 30, y: 30 }, work)).toBe('top-left');
  });

  it('keeps the circle on screen and snaps to edges', () => {
    expect(clampFaceCenter({ x: -100, y: 5000 }, SIZE, work)).toEqual({ x: ext.x + 2, y: 1040 - ext.y - 2 });
    expect(snapFaceCenter({ x: 50, y: 500 }, SIZE, work)).toEqual({ x: ext.x + 2, y: 500 });
    expect(snapFaceCenter({ x: 400, y: 500 }, SIZE, work)).toEqual({ x: 400, y: 500 });
  });

  it('never lets the pause / stop buttons or bubbles go past the screen edge', () => {
    for (const size of [20, 36, 60, 96]) {
      for (const p of [
        clampFaceCenter({ x: 99999, y: 500 }, size, work),
        clampFaceCenter({ x: -99999, y: 500 }, size, work),
        snapFaceCenter(clampFaceCenter({ x: 1915, y: 500 }, size, work), size, work),
        cornerCenter('bottom-right', size, work),
        cornerCenter('top-left', size, work),
      ]) {
        const l = controlsLayout(size, 'left', 'up');
        const rightmost = p.x + Math.max(l.taskStop.x + BUTTON / 2, ...bubbleOffsets(size, 'up').map((b) => b.dx + bubbleGeometry(size).bubble / 2), size / 2 + 6);
        const leftmost = p.x + Math.min(l.taskPause.x - BUTTON / 2, ...bubbleOffsets(size, 'up').map((b) => b.dx - bubbleGeometry(size).bubble / 2), -size / 2 - 6);
        expect(rightmost, `size ${size}`).toBeLessThanOrEqual(work.width);
        expect(leftmost, `size ${size}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('handles a secondary display with negative coordinates', () => {
    const left = { x: -1280, y: 0, width: 1280, height: 984 };
    const c = cornerCenter('bottom-left', SIZE, left);
    expect(c.x).toBe(-1280 + ext.x + 2);
    expect(clampFaceCenter({ x: 50, y: 50 }, SIZE, left).x).toBe(-ext.x - 2);
  });
});

describe('hover bubbles (settings / color)', () => {
  it('lays out two bubbles above the circle', () => {
    const offs = bubbleOffsets(SIZE, 'up');
    expect(offs.map((o) => o.action)).toEqual(['settings', 'color']);
    expect(offs.every((o) => o.dy < -SIZE / 2)).toBe(true);
    expect(offs[0].dx).toBeLessThan(0);
    expect(offs[1].dx).toBeGreaterThan(0);
  });

  it('fits inside the window computed for the same size', () => {
    for (const size of [20, 36, 60, 96]) {
      const g = bubbleGeometry(size);
      for (const dir of ['up', 'down'] as const) {
        for (const o of bubbleOffsets(size, dir)) {
          expect(Math.abs(o.dx) + g.bubble / 2).toBeLessThanOrEqual(g.windowWidth / 2);
          expect(Math.abs(o.dy) + g.bubble / 2).toBeLessThanOrEqual(g.windowHeight / 2);
        }
      }
    }
  });

  it('opens below only when there is no room above', () => {
    expect(bubbleDirection({ x: 500, y: 1010 }, SIZE, 0)).toBe('up');
    expect(bubbleDirection({ x: 500, y: 30 }, SIZE, 0)).toBe('down');
  });

  it('hit-tests bubbles and the corridor', () => {
    const [settings, color] = bubbleOffsets(SIZE, 'up');
    expect(hitBubble({ x: settings.dx, y: settings.dy }, SIZE, 'up')).toBe('settings');
    expect(hitBubble({ x: color.dx, y: color.dy }, SIZE, 'up')).toBe('color');
    expect(hitBubble({ x: 0, y: 0 }, SIZE, 'up')).toBeNull();
    expect(inBubbleCorridor({ x: 0, y: -SIZE / 2 - 2 }, SIZE, 'up')).toBe(true);
    expect(inBubbleCorridor({ x: 0, y: SIZE }, SIZE, 'up')).toBe(false);
  });
});

describe('state resolution (single source of truth)', () => {
  const base: ExpressionInputs = {
    phase: 'idle',
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

  it('maps agent phases', () => {
    expect(resolveExpression({ ...base, phase: 'thinking' })).toBe('thinking');
    expect(resolveExpression({ ...base, phase: 'acting' })).toBe('working');
    expect(resolveExpression({ ...base, phase: 'acting', pendingApproval: true })).toBe('waiting');
    expect(resolveExpression({ ...base, phase: 'paused' })).toBe('waiting');
  });

  it('applies priorities consistently', () => {
    expect(resolveExpression({ ...base, sleeping: true })).toBe('sleep');
    expect(resolveExpression({ ...base, sleeping: true, phase: 'acting' })).toBe('working');
    expect(resolveExpression({ ...base, dragging: true, phase: 'acting' })).toBe('drag');
    expect(resolveExpression({ ...base, reaction: 'success', hover: true })).toBe('success');
    expect(resolveExpression({ ...base, waking: true, sleeping: true })).toBe('waking');
    expect(resolveExpression({ ...base, hover: true })).toBe('hover');
    expect(resolveExpression(base)).toBe('normal');
  });

  it('derives reactions from phase transitions', () => {
    expect(reactionForPhase('acting', 'completed', false)).toBe('success');
    expect(reactionForPhase('thinking', 'failed', false)).toBe('failure');
    expect(reactionForPhase('thinking', 'failed', true)).toBe('error');
    expect(reactionForPhase('acting', 'stopped', false)).toBeNull();
  });
});

describe('white / black palette and circle rendering', () => {
  it('uses only white and black', () => {
    for (const color of ['white', 'black'] as const) {
      const p = paletteFor(color);
      const solid = Object.values(p).filter((v) => v.startsWith('#'));
      for (const v of solid) expect(['#ffffff', '#111111', '#333333', '#dddddd']).toContain(v);
      expect(p['--orb-bg']).not.toBe(p['--orb-fg']);
    }
  });

  it('renders the circle without a face, and both bubbles', () => {
    const html = renderToStaticMarkup(
      createElement(GumiOrb, { size: 36, state: 'thinking', bubbles: { open: true, direction: 'up' } }),
    );
    expect(html).toContain('orb--thinking');
    expect(html).toContain('data-action="settings"');
    expect(html).toContain('data-action="color"');
    expect(html).toContain('bubble open');
    expect(html).not.toMatch(/eye|mouth/);
  });

  it('shows "?" while thinking and animated dots while working', () => {
    const render = (state: 'thinking' | 'working' | 'normal') =>
      renderToStaticMarkup(createElement(GumiOrb, { size: 36, state, bubbles: { open: false, direction: 'up' } }));
    expect(render('thinking')).toContain('orb-question');
    expect(render('thinking')).toContain('>?<');
    expect(render('thinking')).not.toContain('orb-dot');
    expect(render('working').match(/class="orb-dot"/g)).toHaveLength(3);
    expect(render('working')).not.toContain('orb-question');
    expect(render('normal')).not.toMatch(/orb-question|orb-dot/);
  });
});
