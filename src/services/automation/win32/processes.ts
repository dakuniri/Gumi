/**
 * プロセス一覧と状態の取得 (Toolhelp32 スナップショット)。
 */
import {
  win32,
  readWideString,
  IS_64BIT,
  INVALID_HANDLE_VALUE,
  PROCESS_QUERY_LIMITED_INFORMATION,
  TH32CS_SNAPPROCESS,
} from './bindings';

export interface ProcessInfo {
  pid: number;
  parentPid: number;
  threads: number;
  name: string;
}

/** PROCESSENTRY32W のレイアウト */
const LAYOUT = IS_64BIT
  ? { size: 568, pid: 8, threads: 28, parent: 32, exe: 44 }
  : { size: 556, pid: 8, threads: 20, parent: 24, exe: 36 };

export function listProcesses(): ProcessInfo[] {
  const api = win32();
  const snap = api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snap || snap === INVALID_HANDLE_VALUE) throw new Error('プロセス一覧を取得できませんでした');
  const out: ProcessInfo[] = [];
  try {
    const entry = Buffer.alloc(LAYOUT.size);
    entry.writeUInt32LE(LAYOUT.size, 0);
    let ok = api.Process32FirstW(snap, entry);
    while (ok) {
      out.push({
        pid: entry.readUInt32LE(LAYOUT.pid),
        threads: entry.readUInt32LE(LAYOUT.threads),
        parentPid: entry.readUInt32LE(LAYOUT.parent),
        name: readWideString(entry.subarray(LAYOUT.exe, LAYOUT.exe + 520)),
      });
      entry.fill(0);
      entry.writeUInt32LE(LAYOUT.size, 0);
      ok = api.Process32NextW(snap, entry);
    }
  } finally {
    api.CloseHandle(snap);
  }
  return out;
}

const nameCache = new Map<number, { name: string; at: number }>();

/** PID から実行ファイル名を取得 (キャッシュ付き) */
export function getProcessName(pid: number): string | null {
  const cached = nameCache.get(pid);
  if (cached && Date.now() - cached.at < 10_000) return cached.name;
  const path = getProcessPath(pid);
  const name = path ? path.split('\\').pop() ?? path : null;
  if (name) nameCache.set(pid, { name, at: Date.now() });
  return name;
}

export function getProcessPath(pid: number): string | null {
  const api = win32();
  const h = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!h) return null;
  try {
    const buf = Buffer.alloc(2048);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(1024, 0);
    if (!api.QueryFullProcessImageNameW(h, 0, buf, size)) return null;
    return readWideString(buf, size.readUInt32LE(0));
  } finally {
    api.CloseHandle(h);
  }
}
