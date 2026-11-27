/**
 * Smoke test of the packaged Windows app, run by CI after `npm run package`.
 *
 * Launches the unpacked build with `CLIPBOARD_ARCHIVE_SMOKE=1`, `--hidden` and a fresh temp
 * profile. The app checks itself (src/main/app/smoke.ts), writes `smoke-report.json` and exits.
 *
 * What passing means: the packaged app starts, the native koffi module loads and the Win32
 * clipboard listener registers, the renderer loads from app.asar and React renders the palette,
 * and the sandboxed renderer reaches main through the preload bridge and the IPC sender check.
 * Without `--capture` the run never reads or writes the clipboard and does not prove that copies
 * are captured; the sandboxed E2E suite covers capture behaviour.
 *
 * `--capture` (CI only: refused unless `CI=true`, so it never touches a developer's clipboard)
 * also checks real OS copies: once the app listens, this script copies, from a separate PowerShell
 * process through the Windows clipboard, an ordinary token, a token marked
 * `CanIncludeInClipboardHistory = 0` (as password managers do) and, as a positive control, a token
 * from the same writer marked `1`. After each copy it waits for the app to acknowledge the change
 * (by the clipboard sequence number the copy left) and requires: ordinary `recorded`, private
 * `skipped:private-format`, public `recorded`. A lost notification therefore fails the run.
 *
 * Usage: node scripts/smoke-packaged.mjs [--capture] [path/to/app.exe]
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const args = process.argv.slice(2);
const capture = args.includes('--capture');
const TIMEOUT_MS = capture ? 120_000 : 60_000;
/** Names shared with src/main/app/smoke.ts (OS_CAPTURE_READY_FILE, _ACK_FILE, _DONE_FILE). */
const READY_FILE = 'smoke-capture-ready';
const ACK_FILE = 'smoke-capture-acks.jsonl';
const DONE_FILE = 'smoke-capture-done.json';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const exe =
  args.find((arg) => !arg.startsWith('--')) ??
  join('release', pkg.version, 'win-unpacked', `${pkg.productName}.exe`);

process.exitCode = await main();

async function main() {
  if (capture && (process.env.CI !== 'true' || process.platform !== 'win32')) {
    console.error('--capture writes to the system clipboard: it runs only on a Windows CI runner.');
    return 1;
  }
  if (!existsSync(exe)) {
    console.error(`Packaged app not found: ${exe} (run "npm run package" first)`);
    return 1;
  }
  const userData = mkdtempSync(join(tmpdir(), 'clipboard-archive-smoke-'));
  try {
    const exited = launch(userData);
    const copies = capture ? copyThroughClipboard(userData, exited) : Promise.resolve({});
    const [code, copied] = await Promise.all([exited, copies]);
    const reportPath = join(userData, 'smoke-report.json');
    if (!existsSync(reportPath)) {
      printLogs(userData);
      console.error(`The app exited with code ${code} without writing a smoke report.`);
      return 1;
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    console.log(JSON.stringify(report, null, 2));
    const outcomesOk = !capture || (copied !== null && checkOutcomes(copied, report));
    if (!report.ok || code !== 0 || !outcomesOk) {
      printLogs(userData);
      console.error(`Smoke check failed (exit code ${code}).`);
      return 1;
    }
    console.log('Packaged app smoke check passed.');
    return 0;
  } finally {
    // Electron's helper processes can hold the profile for a moment after exit. A leftover
    // temp folder is harmless, so a failed cleanup must not hide the smoke check's result.
    try {
      rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.warn(`Could not remove the temporary profile ${userData}: ${error.code ?? error}`);
    }
  }
}

function launch(userData) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      CLIPBOARD_ARCHIVE_SMOKE: '1',
      CLIPBOARD_ARCHIVE_USER_DATA: userData,
    };
    if (capture) env.CLIPBOARD_ARCHIVE_SMOKE_CAPTURE = '1';
    const child = spawn(exe, ['--hidden'], { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`The app did not finish its smoke check within ${TIMEOUT_MS / 1000} s`));
    }, TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const run = promisify(execFile);

/** Runs a PowerShell script (STA, needed by the WinForms clipboard) with values passed as env. */
function powershell(script, env) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

/** Prints the clipboard sequence number the copy left behind (the app acknowledges it). */
const PRINT_SEQUENCE = `
Add-Type -Namespace SmokeNative -Name Clipboard -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
[SmokeNative.Clipboard]::GetClipboardSequenceNumber()
`;

/** An ordinary copy, then read back to prove it reached the clipboard. */
const NORMAL_COPY = `
$ErrorActionPreference = 'Stop'
Set-Clipboard -Value $env:SMOKE_TOKEN
if ((Get-Clipboard -Raw).TrimEnd() -ne $env:SMOKE_TOKEN) { exit 3 }
${PRINT_SEQUENCE}`;

/**
 * A copy the way password managers make it: the text plus the registered format
 * "CanIncludeInClipboardHistory" holding the DWORD in SMOKE_DWORD (0 = private, 1 = allowed),
 * flushed so it outlives this process. Both the text and the DWORD are read back from the
 * clipboard, so the check never relies on a format that silently failed to register.
 */
const WINFORMS_COPY = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dword = [uint32]$env:SMOKE_DWORD
$data = New-Object System.Windows.Forms.DataObject
$data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $env:SMOKE_TOKEN)
$data.SetData('CanIncludeInClipboardHistory', (New-Object System.IO.MemoryStream(,[BitConverter]::GetBytes($dword))))
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
if ((Get-Clipboard -Raw).TrimEnd() -ne $env:SMOKE_TOKEN) { exit 3 }
$back = [System.Windows.Forms.Clipboard]::GetData('CanIncludeInClipboardHistory')
if ($back -is [System.IO.MemoryStream]) { $bytes = $back.ToArray() } elseif ($back -is [byte[]]) { $bytes = $back } else { exit 4 }
if ($bytes.Length -lt 4 -or [BitConverter]::ToUInt32($bytes, 0) -ne $dword) { exit 4 }
${PRINT_SEQUENCE}`;

/** The last line of a PowerShell run: the clipboard sequence number after its copy. */
function sequenceFrom(stdout) {
  const value = Number(stdout.trim().split(/\r?\n/).at(-1));
  if (!Number.isSafeInteger(value)) throw new Error(`No clipboard sequence number in: ${stdout}`);
  return value;
}

/** Waits until the app acknowledged the change with this clipboard sequence number. */
async function waitForAck(userData, sequence, isExited) {
  const deadline = Date.now() + 15_000;
  const path = join(userData, ACK_FILE);
  while (Date.now() < deadline && !isExited()) {
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let ack;
        try {
          ack = JSON.parse(line);
        } catch {
          continue; // a line still being appended
        }
        if (ack.sequence === sequence) return ack.outcome;
      }
    }
    await sleep(100);
  }
  return null;
}

/**
 * The script half of the OS copy check (see `runOsCaptureCheck` in src/main/app/smoke.ts):
 * waits until the app listens, then makes each copy and waits for the app to acknowledge it
 * (by the clipboard sequence number the copy left), then tells the app what it copied.
 * Returns the acknowledged outcomes, or null when a copy failed.
 */
async function copyThroughClipboard(userData, exited) {
  let appExited = false;
  const markExited = () => {
    appExited = true;
  };
  exited.then(markExited, markExited);
  const deadline = Date.now() + 60_000;
  while (!existsSync(join(userData, READY_FILE))) {
    if (appExited || Date.now() > deadline) {
      console.error('The app never became ready for the clipboard copies.');
      return null;
    }
    await sleep(100);
  }
  const copies = {
    normal: { token: `smoke-normal-${randomUUID()}`, script: NORMAL_COPY, env: {} },
    secret: {
      token: `smoke-private-${randomUUID()}`,
      script: WINFORMS_COPY,
      env: { SMOKE_DWORD: '0' },
    },
    public: {
      token: `smoke-public-${randomUUID()}`,
      script: WINFORMS_COPY,
      env: { SMOKE_DWORD: '1' },
    },
  };
  const report = {};
  const outcomes = {};
  let ok = true;
  for (const [name, copy] of Object.entries(copies)) {
    try {
      const { stdout } = await powershell(copy.script, { ...copy.env, SMOKE_TOKEN: copy.token });
      const sequence = sequenceFrom(stdout);
      report[name] = { token: copy.token, sequence };
      outcomes[name] = await waitForAck(userData, sequence, () => appExited);
    } catch (error) {
      // A copy that never reached the clipboard would make "not recorded" meaningless.
      console.error(
        `The ${name} clipboard copy failed:`,
        error instanceof Error ? error.message : error,
      );
      report[name] = { token: copy.token, sequence: -1 };
      ok = false;
    }
  }
  // Written even after a failure, so the app finishes its report instead of waiting it out.
  // Written to a temp sibling and renamed into place: the app polls for this file and must never
  // open it between its creation and its bytes (an empty file would fail the check).
  const donePath = join(userData, DONE_FILE);
  writeFileSync(`${donePath}.tmp`, JSON.stringify(report));
  renameSync(`${donePath}.tmp`, donePath);
  console.log('Acknowledged clipboard outcomes:', JSON.stringify(outcomes));
  return ok ? outcomes : null;
}

/** The outcomes the check requires, asserted here too (not only inside the app's report). */
function checkOutcomes(outcomes, report) {
  const expected = { normal: 'recorded', secret: 'skipped:private-format', public: 'recorded' };
  let ok = true;
  for (const [name, outcome] of Object.entries(expected)) {
    if (outcomes[name] !== outcome || report.osCapture?.outcomes?.[name] !== outcome) {
      console.error(
        `The ${name} copy was acknowledged as ${String(outcomes[name])} ` +
          `(app report: ${String(report.osCapture?.outcomes?.[name])}), expected ${outcome}.`,
      );
      ok = false;
    }
  }
  return ok;
}

/** The app's own error log (JSONL, no clipboard content), to explain a failure in the CI output. */
function printLogs(userData) {
  const dir = join(userData, 'logs');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    console.error(`--- ${name}`);
    console.error(readFileSync(join(dir, name), 'utf8'));
  }
}
