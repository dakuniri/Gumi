import { describe, expect, it } from 'vitest';
import {
  encodeInputs,
  GUMI_EXTRA_INFO,
  INPUT_KEYBOARD,
  INPUT_MOUSE,
  KEYEVENTF_KEYUP,
  KEYEVENTF_UNICODE,
  MOUSEEVENTF_WHEEL,
  toAbsolute,
  toUtf16Units,
} from '../../src/services/automation/win32/input-struct';

describe('SendInput INPUT encoding', () => {
  it('encodes a 64-bit mouse input (40 bytes, union at 8)', () => {
    const buf = encodeInputs([{ type: 'mouse', mouseData: -120, flags: MOUSEEVENTF_WHEEL }], true);
    expect(buf.length).toBe(40);
    expect(buf.readUInt32LE(0)).toBe(INPUT_MOUSE);
    expect(buf.readInt32LE(8 + 8)).toBe(-120);
    expect(buf.readUInt32LE(8 + 12)).toBe(MOUSEEVENTF_WHEEL);
    expect(buf.readUInt32LE(8 + 16)).toBe(0); // time は 0 (システムが付与)
    expect(buf.readBigUInt64LE(24 + 8)).toBe(BigInt(GUMI_EXTRA_INFO));
  });

  it('encodes 64-bit keyboard inputs back to back', () => {
    const buf = encodeInputs(
      [
        { type: 'keyboard', vk: 0, scan: 0x3042, flags: KEYEVENTF_UNICODE },
        { type: 'keyboard', vk: 0, scan: 0x3042, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP },
      ],
      true,
    );
    expect(buf.length).toBe(80);
    expect(buf.readUInt32LE(40)).toBe(INPUT_KEYBOARD);
    expect(buf.readUInt16LE(40 + 8 + 2)).toBe(0x3042);
    expect(buf.readUInt32LE(40 + 8 + 4)).toBe(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    expect(buf.readBigUInt64LE(40 + 16 + 8)).toBe(BigInt(GUMI_EXTRA_INFO));
  });

  it('encodes 32-bit layout (28 bytes, union at 4)', () => {
    const buf = encodeInputs([{ type: 'keyboard', vk: 0x41, scan: 0x1e, flags: 0 }], false);
    expect(buf.length).toBe(28);
    expect(buf.readUInt16LE(4)).toBe(0x41);
    expect(buf.readUInt32LE(4 + 8)).toBe(0); // time
    expect(buf.readUInt32LE(4 + 12)).toBe(GUMI_EXTRA_INFO);
  });

  it('normalizes absolute coordinates over the virtual desktop', () => {
    const virt = { x: -1920, y: 0, width: 3840, height: 1080 };
    expect(toAbsolute(-1920, 0, virt)).toEqual({ dx: 0, dy: 0 });
    expect(toAbsolute(1919, 1079, virt)).toEqual({ dx: 65535, dy: 65535 });
  });

  it('splits surrogate pairs into two UTF-16 units', () => {
    expect(toUtf16Units('あ')).toEqual([0x3042]);
    expect(toUtf16Units('𠮷')).toHaveLength(2);
  });
});
