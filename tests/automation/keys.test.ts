import { describe, expect, it } from 'vitest';
import {
  acceleratorToCombo,
  comboToString,
  isForbiddenCombo,
  isRiskyCombo,
  parseCombo,
  pasteCombo,
  resolveKey,
} from '../../src/services/automation/keys';

describe('keys', () => {
  it('resolves letters, digits, function keys and aliases', () => {
    expect(resolveKey('a', 'win32').vk).toBe(0x41);
    expect(resolveKey('Z', 'win32').vk).toBe(0x5a);
    expect(resolveKey('7', 'win32').vk).toBe(0x37);
    expect(resolveKey('F5', 'win32').vk).toBe(0x74);
    expect(resolveKey('f24', 'win32').vk).toBe(0x87);
    expect(resolveKey('Esc', 'win32').vk).toBe(0x1b);
    expect(resolveKey('Return', 'win32').vk).toBe(0x0d);
    expect(resolveKey('半角/全角', 'win32').vk).toBe(0xf3);
  });

  it('marks extended keys', () => {
    expect(resolveKey('left', 'win32').extended).toBe(true);
    expect(resolveKey('delete', 'win32').extended).toBe(true);
    expect(resolveKey('a', 'win32').extended).toBe(false);
  });

  it('throws on unknown keys', () => {
    expect(() => resolveKey('foo', 'win32')).toThrow();
  });

  it('parses combos and puts modifiers first', () => {
    expect(comboToString(parseCombo('c+ctrl', 'win32'))).toBe('ctrl+c');
    expect(comboToString(parseCombo('Ctrl + Shift + S', 'win32'))).toBe('ctrl+shift+s');
    expect(comboToString(parseCombo(['alt', 'tab'], 'win32'))).toBe('alt+tab');
    expect(comboToString(parseCombo('ctrl+plus', 'win32'))).toBe('ctrl+plus');
    expect(() => parseCombo('', 'win32')).toThrow();
  });

  it('detects forbidden and risky combos', () => {
    expect(isForbiddenCombo(parseCombo('ctrl+alt+delete', 'win32'))).toBe(true);
    expect(isForbiddenCombo(parseCombo('win+l', 'win32'))).toBe(true);
    expect(isForbiddenCombo(parseCombo('ctrl+c', 'win32'))).toBe(false);
    expect(isForbiddenCombo(parseCombo('ctrl+alt+escape', 'win32'), [acceleratorToCombo('Control+Alt+Escape', 'win32')])).toBe(true);
    expect(isRiskyCombo(parseCombo('win+r', 'win32'))).toBe(true);
    expect(isRiskyCombo(parseCombo('alt+f4', 'win32'))).toBe(true);
    expect(isRiskyCombo(parseCombo('shift+delete', 'win32'))).toBe(true);
    expect(isRiskyCombo(parseCombo('ctrl+s', 'win32'))).toBe(false);
  });
});

describe('keys (macOS)', () => {
  it('resolves macOS virtual key codes', () => {
    expect(resolveKey('a', 'darwin').vk).toBe(0x00);
    expect(resolveKey('s', 'darwin').vk).toBe(0x01);
    expect(resolveKey('Return', 'darwin').vk).toBe(0x24);
    expect(resolveKey('Esc', 'darwin').vk).toBe(0x35);
    expect(resolveKey('backspace', 'darwin').vk).toBe(0x33);
    expect(resolveKey('left', 'darwin').vk).toBe(0x7b);
    expect(resolveKey('space', 'darwin').vk).toBe(0x31);
  });

  it('maps Windows / meta names to Command', () => {
    expect(resolveKey('cmd', 'darwin').name).toBe('cmd');
    expect(resolveKey('command', 'darwin').name).toBe('cmd');
    expect(resolveKey('win', 'darwin').name).toBe('cmd');
    expect(resolveKey('option', 'darwin').name).toBe('alt');
    expect(comboToString(parseCombo('Cmd + Shift + 4', 'darwin'))).toBe('cmd+shift+4');
    expect(resolveKey('cmd', 'win32').name).toBe('win');
  });

  it('uses cmd for paste and CommandOrControl on macOS', () => {
    expect(pasteCombo('darwin')).toBe('cmd+v');
    expect(pasteCombo('win32')).toBe('ctrl+v');
    expect(acceleratorToCombo('CommandOrControl+Shift+Escape', 'darwin')).toEqual(['cmd', 'shift', 'escape']);
    expect(acceleratorToCombo('CommandOrControl+Shift+Escape', 'win32')).toEqual(['ctrl', 'shift', 'escape']);
  });

  it('forbids lock / logout / empty trash and flags quit as risky', () => {
    expect(isForbiddenCombo(parseCombo('ctrl+cmd+q', 'darwin'))).toBe(true);
    expect(isForbiddenCombo(parseCombo('cmd+shift+q', 'darwin'))).toBe(true);
    expect(isForbiddenCombo(parseCombo('cmd+alt+escape', 'darwin'))).toBe(true);
    expect(isForbiddenCombo(parseCombo('cmd+shift+backspace', 'darwin'))).toBe(true);
    expect(isRiskyCombo(parseCombo('cmd+q', 'darwin'))).toBe(true);
    expect(isRiskyCombo(parseCombo('cmd+backspace', 'darwin'))).toBe(true);
    expect(isRiskyCombo(parseCombo('cmd+s', 'darwin'))).toBe(false);
  });

  it('rejects keys that do not exist on a Mac keyboard', () => {
    expect(() => resolveKey('printscreen', 'darwin')).toThrow();
  });
});
