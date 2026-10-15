/**
 * 会話履歴・操作履歴の保存 (JSON ファイル)。
 * スクリーンショット画像は保存しない (プライバシー保護)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LogEntry, TaskRecord, TaskSummary } from '../../types/agent';

const MAX_LOG_PER_TASK = 1000;

export class HistoryStore {
  private tasks: TaskRecord[] = [];
  private loaded = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly options: () => { enabled: boolean; maxTasks: number },
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (Array.isArray(raw?.tasks)) {
        this.tasks = raw.tasks.filter(isTaskRecord).map((t: TaskRecord) =>
          t.status === 'running' ? { ...t, status: 'stopped', endedAt: t.endedAt ?? t.startedAt } : t,
        );
      }
    } catch {
      this.tasks = [];
    }
  }

  begin(record: Omit<TaskRecord, 'log'>): void {
    this.tasks.unshift({ ...record, log: [] });
    this.trim();
    this.scheduleSave();
  }

  append(taskId: string, entry: LogEntry): void {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.log.push(entry);
    if (t.log.length > MAX_LOG_PER_TASK) t.log.splice(0, t.log.length - MAX_LOG_PER_TASK);
    this.scheduleSave();
  }

  finish(taskId: string, patch: Partial<Pick<TaskRecord, 'status' | 'endedAt' | 'summary' | 'steps'>>): void {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return;
    Object.assign(t, patch);
    this.scheduleSave(true);
  }

  list(): TaskSummary[] {
    return this.tasks.map(({ log, ...rest }) => ({ ...rest, logCount: log.length }));
  }

  get(id: string): TaskRecord | null {
    return this.tasks.find((t) => t.id === id) ?? null;
  }

  /** 全タスクの操作ログ (新しい順) */
  operations(limit = 300): LogEntry[] {
    const out: LogEntry[] = [];
    for (const t of this.tasks) {
      for (let i = t.log.length - 1; i >= 0; i--) {
        const e = t.log[i];
        if (e.kind === 'action' || e.kind === 'result' || e.kind === 'approval' || e.kind === 'error') out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async clear(): Promise<void> {
    this.tasks = this.tasks.filter((t) => t.status === 'running').map((t) => ({ ...t, log: [] }));
    await this.saveNow();
  }

  private trim() {
    const max = this.options().maxTasks;
    if (this.tasks.length > max) this.tasks.length = max;
  }

  private scheduleSave(soon = false) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), soon ? 100 : 1500);
  }

  async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const { enabled } = this.options();
    this.writing = this.writing.then(async () => {
      try {
        if (!enabled) {
          // 履歴保存が無効: ディスク上の履歴を残さない
          await fs.rm(this.file, { force: true });
          return;
        }
        this.trim();
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify({ version: 1, tasks: this.tasks }), 'utf8');
        await fs.rename(tmp, this.file);
      } catch (err) {
        console.error('[gumi] 履歴の保存に失敗しました', err);
      }
    });
    return this.writing;
  }
}

function isTaskRecord(v: unknown): v is TaskRecord {
  const t = v as TaskRecord;
  return !!t && typeof t.id === 'string' && typeof t.text === 'string' && Array.isArray(t.log);
}
