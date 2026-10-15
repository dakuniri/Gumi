/**
 * 実行中の OS に合った PC 操作エンジンを作る。
 * Windows: Win32 (SendInput) + UI Automation / macOS: CoreGraphics (CGEvent) + アクセシビリティ API
 */
import { createWindowsAutomation } from './win32/driver';
import { createMacAutomation } from './macos/driver';
import type { Automation } from './types';
import type { SpeedProfile } from './util';

export function createAutomation(opts: { speed: () => SpeedProfile; workDir: string }): Automation {
  if (process.platform === 'darwin') return createMacAutomation({ speed: opts.speed });
  return createWindowsAutomation(opts);
}
