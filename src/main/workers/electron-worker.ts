import { utilityProcess } from 'electron';
import type { WorkerProcess } from './worker-client';

export interface WorkerLaunch {
  /** Built entry module, e.g. out/main/ocr-host.js. */
  readonly entry: string;
  readonly args: readonly string[];
  /** Shown in the OS task manager. */
  readonly serviceName: string;
}

/**
 * Starts a worker as an Electron utility process: a Node-only child with no window, no renderer
 * and no access to the app's IPC. Its stdout/stderr are dropped so engine chatter ("Estimating
 * resolution as …") does not reach the user's terminal.
 */
export function spawnElectronWorker<Payload>(launch: WorkerLaunch): WorkerProcess<Payload> {
  const child = utilityProcess.fork(launch.entry, [...launch.args], {
    serviceName: launch.serviceName,
    stdio: 'ignore',
  });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on('message', listener),
    onExit: (listener) => child.on('exit', listener),
    kill: () => void child.kill(),
  };
}
