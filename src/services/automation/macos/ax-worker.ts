/**
 * アクセシビリティ API を呼ぶワーカースレッドの入口 (macOS)。
 * scripts/build-electron.mjs で単体のスクリプトにまとめ、Main に文字列として埋め込む。
 * メッセージ: { id, op, args } -> { id, ok: true, result } | { id, ok: false, error }
 */
import { parentPort } from 'node:worker_threads';
import { handlers, type AxOp } from './ax-core';

interface Request {
  id: number;
  op: AxOp;
  args: unknown;
}

parentPort?.on('message', (msg: Request) => {
  try {
    const fn = handlers[msg.op] as ((a: unknown) => unknown) | undefined;
    if (!fn) throw new Error(`unknown op: ${msg.op}`);
    const result = fn(msg.args ?? {});
    parentPort?.postMessage({ id: msg.id, ok: true, result: result === undefined ? null : result });
  } catch (err) {
    const e = err as Error & { code?: number };
    parentPort?.postMessage({ id: msg.id, ok: false, error: e.message || String(err), code: e.code });
  }
});
