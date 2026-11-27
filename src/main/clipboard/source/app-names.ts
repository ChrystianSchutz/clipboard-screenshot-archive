/**
 * Friendly names for well-known executables, so filters say "VS Code" rather than "Code.exe".
 * Keys are lower-case file names. Unknown executables fall back to a cleaned-up file name.
 */
const KNOWN_APPS: Readonly<Record<string, string>> = {
  'code.exe': 'VS Code',
  'code - insiders.exe': 'VS Code Insiders',
  'cursor.exe': 'Cursor',
  'windsurf.exe': 'Windsurf',
  'zed.exe': 'Zed',
  'devenv.exe': 'Visual Studio',
  'idea64.exe': 'IntelliJ IDEA',
  'webstorm64.exe': 'WebStorm',
  'pycharm64.exe': 'PyCharm',
  'rider64.exe': 'Rider',
  'goland64.exe': 'GoLand',
  'sublime_text.exe': 'Sublime Text',
  'notepad++.exe': 'Notepad++',
  'notepad.exe': 'Notepad',
  'chrome.exe': 'Chrome',
  'msedge.exe': 'Edge',
  'firefox.exe': 'Firefox',
  'brave.exe': 'Brave',
  'opera.exe': 'Opera',
  'vivaldi.exe': 'Vivaldi',
  'arc.exe': 'Arc',
  'windowsterminal.exe': 'Windows Terminal',
  'wt.exe': 'Windows Terminal',
  'powershell.exe': 'PowerShell',
  'pwsh.exe': 'PowerShell',
  'cmd.exe': 'Command Prompt',
  'conhost.exe': 'Console',
  'postman.exe': 'Postman',
  'insomnia.exe': 'Insomnia',
  'bruno.exe': 'Bruno',
  'slack.exe': 'Slack',
  'ms-teams.exe': 'Teams',
  'teams.exe': 'Teams',
  'discord.exe': 'Discord',
  'outlook.exe': 'Outlook',
  'olk.exe': 'Outlook',
  'winword.exe': 'Word',
  'excel.exe': 'Excel',
  'obsidian.exe': 'Obsidian',
  'notion.exe': 'Notion',
  'explorer.exe': 'File Explorer',
  'datagrip64.exe': 'DataGrip',
  'ssms.exe': 'SQL Server Management Studio',
  'dbeaver.exe': 'DBeaver',
};

/** "C:\\Program Files\\Microsoft VS Code\\Code.exe" → "Code.exe". Accepts / and \ separators. */
export function exeFromPath(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** "Code.exe" → "VS Code"; "my-tool.exe" → "my-tool"; "" → null. */
export function friendlyAppName(exe: string): string | null {
  const trimmed = exe.trim();
  if (trimmed === '') return null;
  return KNOWN_APPS[trimmed.toLowerCase()] ?? trimmed.replace(/\.exe$/i, '');
}
