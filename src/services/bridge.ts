/**
 * Renderer から見た Main Process への唯一の窓口 (preload が公開する window.gumi)。
 */
import type { GumiApi } from '../types/ipc';

declare global {
  interface Window {
    gumi?: GumiApi;
  }
}

export function gumi(): GumiApi {
  if (!window.gumi) throw new Error('Gumi API が利用できません (preload が読み込まれていません)');
  return window.gumi;
}
