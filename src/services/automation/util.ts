export class AbortedError extends Error {
  constructor(message = '操作は停止されました') {
    super(message);
    this.name = 'AbortedError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

/** AbortSignal 対応の sleep */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof AbortedError ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'AbortedError'))
  );
}

export type Speed = 'slow' | 'normal' | 'fast';

export interface SpeedProfile {
  moveDurationMs: number;
  keyDelayMs: number;
  clickGapMs: number;
  settleMs: number;
}

export const SPEED_PROFILES: Record<Speed, SpeedProfile> = {
  slow: { moveDurationMs: 600, keyDelayMs: 40, clickGapMs: 120, settleMs: 1200 },
  normal: { moveDurationMs: 250, keyDelayMs: 12, clickGapMs: 60, settleMs: 700 },
  fast: { moveDurationMs: 80, keyDelayMs: 3, clickGapMs: 40, settleMs: 350 },
};
