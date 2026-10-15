/**
 * 設定の永続化 (Main Process)。
 * - settings.json に検証済み設定を保存 (アトミック書き込み)
 * - API キーは Electron safeStorage (Windows は DPAPI、macOS はキーチェーン) で暗号化して secrets.json に保存
 * - Renderer には API キーを渡さず、設定済みかどうかだけを公開する
 */
import { EventEmitter } from 'node:events';
import { promises as fs, copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PROVIDER_IDS,
  defaultSettings,
  deepMerge,
  migrateSettings,
  settingsSchema,
  type ProviderId,
  type PublicSettings,
  type Settings,
  type SettingsPatch,
} from './schema';

export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class SettingsStore extends EventEmitter {
  private settings: Settings = defaultSettings();
  private secrets: Partial<Record<ProviderId, string>> = {};
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly cipher: SecretCipher,
  ) {
    super();
  }

  private get settingsFile() {
    return path.join(this.dir, 'settings.json');
  }

  private get secretsFile() {
    return path.join(this.dir, 'secrets.json');
  }

  /** 起動時に同期的に読み込む (ウィンドウ生成前に必要なため) */
  loadSync(): void {
    const raw = this.readJson(this.settingsFile);
    if (raw === undefined) {
      this.settings = defaultSettings();
    } else {
      this.settings = migrateSettings(raw);
      // 古い形式から移行した場合はすぐに新しい形式で保存する
      if ((raw as { version?: unknown })?.version !== this.settings.version) this.persist();
    }
    const secrets = this.readJson(this.secretsFile) as Record<string, unknown> | undefined;
    this.secrets = {};
    for (const id of PROVIDER_IDS) {
      const v = secrets?.[id];
      if (typeof v === 'string' && v) this.secrets[id] = v;
    }
  }

  /**
   * JSON ファイルを読む。存在しなければ undefined。
   * 壊れていた場合は上書きで失われないよう、*.corrupt-<日時>.json としてコピーを残してから undefined を返す。
   */
  private readJson(file: string): unknown {
    if (!existsSync(file)) return undefined;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
      return JSON.parse(text.replace(/^﻿/, ''));
    } catch (err) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = file.replace(/\.json$/, `.corrupt-${stamp}.json`);
      try {
        copyFileSync(file, backup);
        console.error(`[gumi] ${path.basename(file)} を読み込めなかったため ${path.basename(backup)} に退避しました`, err);
      } catch {
        /* 退避できなくても起動は続ける */
      }
      return undefined;
    }
  }

  /** 保存先フォルダ */
  get directory(): string {
    return this.dir;
  }

  get(): Settings {
    return this.settings;
  }

  getPublic(): PublicSettings {
    const apiKeys = Object.fromEntries(PROVIDER_IDS.map((id) => [id, !!this.secrets[id]])) as Record<ProviderId, boolean>;
    return {
      ...structuredClone(this.settings),
      apiKeys,
      secureStorageAvailable: this.cipher.isEncryptionAvailable(),
    };
  }

  /** 部分更新。検証に失敗した場合は例外を投げ、設定は変更しない。 */
  update(patch: SettingsPatch): Settings {
    const merged = deepMerge(this.settings, patch);
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`設定値が不正です: ${msg}`);
    }
    const prev = this.settings;
    this.settings = parsed.data;
    this.persist();
    this.emit('changed', this.settings, prev);
    return this.settings;
  }

  reset(): Settings {
    const prev = this.settings;
    // 位置情報だけは保持すると混乱するので含めて初期化する
    this.settings = defaultSettings();
    this.persist();
    this.emit('changed', this.settings, prev);
    return this.settings;
  }

  setApiKey(provider: ProviderId, key: string): void {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('API キーが空です');
    if (trimmed.length > 500) throw new Error('API キーが長すぎます');
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error('OS の安全な保存領域 (Windows: DPAPI / macOS: キーチェーン) が利用できないため、API キーを保存できません');
    }
    this.secrets[provider] = this.cipher.encryptString(trimmed).toString('base64');
    this.persistSecrets();
    this.emit('changed', this.settings, this.settings);
  }

  clearApiKey(provider: ProviderId): void {
    delete this.secrets[provider];
    this.persistSecrets();
    this.emit('changed', this.settings, this.settings);
  }

  /** Main Process 内でのみ使用する (Renderer へは絶対に渡さない) */
  getApiKey(provider: ProviderId): string {
    const enc = this.secrets[provider];
    if (!enc) return '';
    try {
      return this.cipher.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return '';
    }
  }

  private persist() {
    const data = JSON.stringify(this.settings, null, 2);
    this.write(this.settingsFile, data);
  }

  private persistSecrets() {
    // 暗号化済みだが、念のため本人だけが読めるようにする (macOS / Linux。Windows ではユーザーフォルダの権限に従う)
    this.write(this.secretsFile, JSON.stringify(this.secrets), 0o600);
  }

  private write(file: string, data: string, mode = 0o644) {
    this.writeChain = this.writeChain.then(async () => {
      try {
        await fs.mkdir(this.dir, { recursive: true });
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, data, { encoding: 'utf8', mode });
        await fs.rename(tmp, file);
      } catch (err) {
        console.error('[gumi] 設定の保存に失敗しました', err);
      }
    });
  }

  flush(): Promise<void> {
    return this.writeChain;
  }
}
