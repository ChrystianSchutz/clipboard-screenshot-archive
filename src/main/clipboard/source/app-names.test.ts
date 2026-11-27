import { describe, expect, it } from 'vitest';
import { exeFromPath, friendlyAppName } from './app-names';

describe('exeFromPath', () => {
  it('takes the file name from a Windows path', () => {
    expect(exeFromPath('C:\\Program Files\\Microsoft VS Code\\Code.exe')).toBe('Code.exe');
  });

  it('accepts forward slashes and mixed separators', () => {
    expect(exeFromPath('C:/Tools\\bin/my-tool.exe')).toBe('my-tool.exe');
  });

  it('returns a bare file name unchanged', () => {
    expect(exeFromPath('notepad.exe')).toBe('notepad.exe');
  });

  it('keeps spaces and non-ASCII characters in the file name', () => {
    expect(exeFromPath('D:\\Apps\\Zażółć\\Code - Insiders.exe')).toBe('Code - Insiders.exe');
  });

  it('returns an empty string for a path ending in a separator', () => {
    expect(exeFromPath('C:\\Windows\\')).toBe('');
  });
});

describe('friendlyAppName', () => {
  it.each([
    ['Code.exe', 'VS Code'],
    ['Code - Insiders.exe', 'VS Code Insiders'],
    ['chrome.exe', 'Chrome'],
    ['msedge.exe', 'Edge'],
    ['WindowsTerminal.exe', 'Windows Terminal'],
    ['pwsh.exe', 'PowerShell'],
  ])('maps the known executable %s to %s', (exe, name) => {
    expect(friendlyAppName(exe)).toBe(name);
  });

  it('looks known executables up case-insensitively', () => {
    expect(friendlyAppName('CODE.EXE')).toBe('VS Code');
  });

  it('ignores surrounding whitespace', () => {
    expect(friendlyAppName('  slack.exe \t')).toBe('Slack');
  });

  it('strips the .exe extension (any case) from unknown executables', () => {
    expect(friendlyAppName('my-tool.exe')).toBe('my-tool');
    expect(friendlyAppName('MyTool.EXE')).toBe('MyTool');
  });

  it('keeps names without an extension, and only strips a trailing .exe', () => {
    expect(friendlyAppName('firefox')).toBe('firefox');
    expect(friendlyAppName('app.exe.config')).toBe('app.exe.config');
  });

  it.each(['', '   '])('returns null for the blank name %j', (exe) => {
    expect(friendlyAppName(exe)).toBeNull();
  });
});
