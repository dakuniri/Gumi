import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertSafePath,
  defaultProtectedRoots,
  copyPath,
  createFolder,
  listDirectory,
  movePath,
  readTextFile,
  renamePath,
  resolveUserPath,
  writeTextFile,
  type FileSafetyConfig,
} from '../../src/services/automation/files';
import { findStartApp, isHighRiskApp, scoreAppMatch } from '../../src/services/automation/apps';
import { isMacHighRiskApp } from '../../src/services/automation/macos/apps';

const cfg: FileSafetyConfig = {
  folders: {
    home: 'C:\\Users\\me',
    desktop: 'C:\\Users\\me\\Desktop',
    documents: 'C:\\Users\\me\\Documents',
    downloads: 'C:\\Users\\me\\Downloads',
    pictures: 'C:\\Users\\me\\Pictures',
    music: 'C:\\Users\\me\\Music',
    videos: 'C:\\Users\\me\\Videos',
  },
  protectedRoots: ['C:\\Windows', 'C:\\Program Files'],
  platform: 'win32',
};

const macCfg: FileSafetyConfig = {
  folders: {
    home: '/Users/me',
    desktop: '/Users/me/Desktop',
    documents: '/Users/me/Documents',
    downloads: '/Users/me/Downloads',
    pictures: '/Users/me/Pictures',
    music: '/Users/me/Music',
    videos: '/Users/me/Movies',
  },
  protectedRoots: defaultProtectedRoots({ HOME: '/Users/me' }, 'darwin'),
  platform: 'darwin',
};

describe('path resolution and safety', () => {
  it('expands folder aliases (English and Japanese)', () => {
    expect(resolveUserPath('Desktop\\新しいフォルダ', cfg)).toBe('C:\\Users\\me\\Desktop\\新しいフォルダ');
    expect(resolveUserPath('ダウンロード/a.txt', cfg)).toBe('C:\\Users\\me\\Downloads\\a.txt');
    expect(resolveUserPath('~\\x', cfg)).toBe('C:\\Users\\me\\x');
    expect(resolveUserPath('%FOO%\\y', cfg, { FOO: 'D:\\data' })).toBe('D:\\data\\y');
  });

  it('rejects relative or invalid paths', () => {
    expect(() => resolveUserPath('foo\\bar', cfg)).toThrow();
    expect(() => resolveUserPath('C:\\a|b', cfg)).toThrow();
    expect(() => resolveUserPath('', cfg)).toThrow();
  });

  it('blocks protected, root and network locations', () => {
    expect(() => assertSafePath('C:\\Windows\\System32\\x.dll', cfg)).toThrow();
    expect(() => assertSafePath('c:\\program files\\app', cfg)).toThrow();
    expect(() => assertSafePath('C:\\', cfg)).toThrow();
    expect(() => assertSafePath('\\\\server\\share\\x', cfg)).toThrow();
    expect(assertSafePath('C:\\Users\\me\\Desktop\\a.txt', cfg)).toBe('C:\\Users\\me\\Desktop\\a.txt');
  });
});

describe('path resolution and safety (macOS)', () => {
  it('expands folder aliases, ~ and $HOME', () => {
    expect(resolveUserPath('Desktop/新しいフォルダ', macCfg)).toBe('/Users/me/Desktop/新しいフォルダ');
    expect(resolveUserPath('ダウンロード/a.txt', macCfg)).toBe('/Users/me/Downloads/a.txt');
    expect(resolveUserPath('~/x/', macCfg)).toBe('/Users/me/x');
    expect(resolveUserPath('$HOME/y', macCfg, { HOME: '/Users/me' })).toBe('/Users/me/y');
    expect(resolveUserPath('/Volumes/USB/z.txt', macCfg)).toBe('/Volumes/USB/z.txt');
  });

  it('rejects relative paths', () => {
    expect(() => resolveUserPath('foo/bar', macCfg)).toThrow();
    expect(() => resolveUserPath('', macCfg)).toThrow();
  });

  it('blocks system locations, ~/Library, roots and volumes', () => {
    expect(() => assertSafePath('/System/Library/x', macCfg)).toThrow();
    expect(() => assertSafePath('/Applications/Safari.app', macCfg)).toThrow();
    expect(() => assertSafePath('/usr/local/bin/x', macCfg)).toThrow();
    expect(() => assertSafePath('/Users/me/Library/Keychains/login.keychain-db', macCfg)).toThrow();
    expect(() => assertSafePath('/users/ME/library/x', macCfg)).toThrow();
    expect(() => assertSafePath('/', macCfg)).toThrow();
    expect(() => assertSafePath('/Volumes/USB', macCfg)).toThrow();
    expect(assertSafePath('/Users/me/Desktop/a.txt', macCfg)).toBe('/Users/me/Desktop/a.txt');
    expect(assertSafePath('/Volumes/USB/a.txt', macCfg)).toBe('/Volumes/USB/a.txt');
  });
});

describe('file operations (temp dir)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gumi-test-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('creates, writes, reads, renames, copies and moves without overwriting', async () => {
    const folder = path.join(dir, '整理');
    expect(await createFolder(folder)).toEqual({ created: true });
    expect(await createFolder(folder)).toEqual({ created: false });

    const file = path.join(dir, 'memo.txt');
    await writeTextFile(file, 'こんにちは', false);
    await expect(writeTextFile(file, 'x', false)).rejects.toThrow();
    expect((await readTextFile(file)).text).toBe('こんにちは');

    const renamed = await renamePath(file, 'note.txt');
    expect(path.basename(renamed)).toBe('note.txt');
    await expect(renamePath(renamed, 'bad/name')).rejects.toThrow();

    const copied = await copyPath(renamed, folder);
    expect(copied).toBe(path.join(folder, 'note.txt'));
    await expect(copyPath(renamed, folder)).rejects.toThrow();

    await expect(movePath(renamed, folder)).rejects.toThrow(); // 同名が既に存在
    const moved = await movePath(renamed, path.join(folder, 'note2.txt'));
    expect(await fs.readFile(moved, 'utf8')).toBe('こんにちは');

    const listing = await listDirectory(folder);
    expect(listing.entries.map((e) => e.name).sort()).toEqual(['note.txt', 'note2.txt']);
  });

  it('refuses to read binary files', async () => {
    const bin = path.join(dir, 'b.bin');
    await fs.writeFile(bin, Buffer.from([0, 1, 2, 3]));
    await expect(readTextFile(bin)).rejects.toThrow();
  });
});

describe('app launching helpers', () => {
  it('scores and finds start menu apps', () => {
    const apps = [
      { name: 'Google Chrome', appId: 'C:\\chrome.exe' },
      { name: 'Microsoft Edge', appId: 'MSEdge' },
      { name: 'メモ帳', appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' },
    ];
    expect(scoreAppMatch('chrome', 'Google Chrome')).toBeGreaterThan(0);
    expect(findStartApp('chrome', apps)?.name).toBe('Google Chrome');
    expect(findStartApp('メモ帳', apps)?.appId).toContain('Notepad');
    expect(findStartApp('photoshop', apps)).toBeNull();
  });

  it('flags shells, installers and admin tools as high risk', () => {
    for (const n of ['cmd', 'powershell.exe', 'pwsh', 'regedit', 'setup.exe', 'C:\\x\\run.bat', 'installer.msi', 'Windows Terminal']) {
      expect(isHighRiskApp(n), n).toBe(true);
    }
    for (const n of ['notepad', 'Google Chrome', '電卓']) expect(isHighRiskApp(n), n).toBe(false);
  });

  it('flags macOS shells, scripts, installers and admin tools as high risk', () => {
    for (const n of ['Terminal', 'ターミナル', 'iTerm', 'Script Editor', 'Disk Utility', 'Keychain Access', 'Installer', '/Users/me/run.command', 'x.pkg', 'Activity Monitor']) {
      expect(isMacHighRiskApp(n), n).toBe(true);
    }
    for (const n of ['Safari', 'TextEdit', 'テキストエディット', 'Finder', 'Google Chrome', 'System Settings']) {
      expect(isMacHighRiskApp(n), n).toBe(false);
    }
  });
});
