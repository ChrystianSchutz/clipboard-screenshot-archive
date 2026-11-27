import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { InvokeArgs, InvokeChannel, InvokeResult } from '@shared/ipc-contract';
import { ipcSchemas } from './schemas';
import type { TrustedSender } from './sender-policy';

/**
 * One handler per channel. After the validated arguments it receives the verified sender, so a
 * handler can act on the calling window (most handlers simply leave that parameter out).
 */
export type InvokeHandlers = {
  [C in InvokeChannel]: (
    ...args: [...InvokeArgs<C>, sender: TrustedSender]
  ) => InvokeResult<C> | Promise<InvokeResult<C>>;
};

export class IpcValidationError extends Error {
  override readonly name = 'IpcValidationError';
}

/**
 * Wires every handler to `ipcMain.handle` behind two gates:
 * 1. `authorize` must accept the sender for this channel (see `sender-policy.ts`);
 * 2. the arguments must pass the channel's schema.
 *
 * `InvokeHandlers` is a mapped type over the contract, so a missing or mistyped handler is a
 * compile error, not a runtime surprise.
 */
export function registerIpcHandlers(
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  handlers: InvokeHandlers,
  authorize: (event: IpcMainInvokeEvent, channel: InvokeChannel) => TrustedSender | null,
): () => void {
  const channels = Object.keys(handlers) as InvokeChannel[];

  for (const channel of channels) {
    ipcMain.handle(channel, (event, ...rawArgs: unknown[]) => {
      const sender = authorize(event, channel);
      if (!sender) {
        throw new IpcValidationError(`Rejected ${channel} from an untrusted sender`);
      }
      const parsed = ipcSchemas[channel].safeParse(rawArgs);
      if (!parsed.success) {
        throw new IpcValidationError(`Invalid arguments for ${channel}: ${parsed.error.message}`);
      }
      const handler = handlers[channel] as (...args: unknown[]) => unknown;
      return handler(...(parsed.data as unknown[]), sender);
    });
  }

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
