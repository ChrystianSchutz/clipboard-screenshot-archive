import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { InvokeChannel } from '@shared/ipc-contract';
import { MAX_BATCH_IDS } from '@shared/types';
import { IpcValidationError, registerIpcHandlers } from './register';
import { ipcSchemas } from './schemas';
import type { TrustedSender } from './sender-policy';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** Captures what `ipcMain.handle` receives, and lets a test invoke a channel like a renderer would. */
class FakeIpcMain implements Pick<IpcMain, 'handle' | 'removeHandler'> {
  readonly listeners = new Map<string, Listener>();

  readonly handle = vi.fn((channel: string, listener: Listener) => {
    // Electron throws when a channel already has a handler.
    if (this.listeners.has(channel))
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.listeners.set(channel, listener);
  });

  readonly removeHandler = vi.fn((channel: string) => {
    this.listeners.delete(channel);
  });

  invoke(channel: InvokeChannel, event: IpcMainInvokeEvent, ...args: unknown[]): unknown {
    const listener = this.listeners.get(channel);
    if (!listener) throw new Error(`No handler registered for '${channel}'`);
    return listener(event, ...args);
  }
}

const CHANNELS = Object.keys(ipcSchemas) as InvokeChannel[];

/** The ids 1..count. */
const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);

function fakeEvent(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url } } as unknown as IpcMainInvokeEvent;
}

const trustedEvent = fakeEvent('app://clipboard-archive/index.html');
const untrustedEvent = fakeEvent('https://evil.example/');
const PALETTE: TrustedSender = { role: 'palette' };

describe('registerIpcHandlers', () => {
  let ipcMain: FakeIpcMain;
  let handlers: Record<InvokeChannel, Mock>;
  let authorize: Mock<(event: IpcMainInvokeEvent, channel: InvokeChannel) => TrustedSender | null>;
  let dispose: () => void;

  beforeEach(() => {
    ipcMain = new FakeIpcMain();
    handlers = Object.fromEntries(
      CHANNELS.map((channel) => [channel, vi.fn(() => `${channel} result`)]),
    ) as Record<InvokeChannel, Mock>;
    authorize = vi.fn((event: IpcMainInvokeEvent) => (event === trustedEvent ? PALETTE : null));
    dispose = registerIpcHandlers(ipcMain, handlers, authorize);
  });

  it('registers exactly one handler per contract channel', () => {
    expect([...ipcMain.listeners.keys()].sort()).toEqual([...CHANNELS].sort());
    expect(ipcMain.handle).toHaveBeenCalledTimes(CHANNELS.length);
  });

  describe('trusted sender with valid arguments', () => {
    it('calls the handler with the arguments, then the verified sender, and returns its result', () => {
      const result = ipcMain.invoke('history:set-pinned', trustedEvent, 7, true);

      expect(handlers['history:set-pinned']).toHaveBeenCalledExactlyOnceWith(7, true, PALETTE);
      expect(result).toBe('history:set-pinned result');
    });

    it('calls a no-argument handler with only the verified sender', () => {
      ipcMain.invoke('history:apps', trustedEvent);

      expect(handlers['history:apps']).toHaveBeenCalledExactlyOnceWith(PALETTE);
    });

    it('passes the parsed arguments, not the raw ones (trimmed accelerators)', () => {
      ipcMain.invoke('settings:update', trustedEvent, {
        shortcuts: { compare: '  Alt+Shift+D  ' },
      });

      expect(handlers['settings:update']).toHaveBeenCalledWith(
        { shortcuts: { compare: 'Alt+Shift+D' } },
        PALETTE,
      );
    });

    it('passes a full history query through unchanged', () => {
      const query = {
        text: 'timeout',
        regex: false,
        app: 'Chrome',
        kind: 'json',
        range: '7d',
        pinnedOnly: true,
        category: 'sql',
        before: { lastCopiedAt: 1_700_000_000_000, id: 42 },
        limit: 50,
      };

      ipcMain.invoke('history:query', trustedEvent, query);

      expect(handlers['history:query']).toHaveBeenCalledWith(query, PALETTE);
    });

    it('returns the promise of an async handler', async () => {
      handlers['stats:get'].mockResolvedValueOnce({ totalClips: 3 });

      await expect(ipcMain.invoke('stats:get', trustedEvent)).resolves.toEqual({ totalClips: 3 });
    });

    it('lets errors thrown by the handler reach the caller', () => {
      handlers['history:restore'].mockImplementationOnce(() => {
        throw new Error('Clip not found');
      });

      expect(() => ipcMain.invoke('history:restore', trustedEvent, 1)).toThrow('Clip not found');
    });
  });

  describe('untrusted sender', () => {
    it('rejects the call with an IpcValidationError and never runs the handler', () => {
      expect(() => ipcMain.invoke('history:clear', untrustedEvent, { keepPinned: false })).toThrow(
        new IpcValidationError('Rejected history:clear from an untrusted sender'),
      );
      expect(handlers['history:clear']).not.toHaveBeenCalled();
    });

    it('checks the sender on every call, not once at registration', () => {
      ipcMain.invoke('app:info', trustedEvent);
      authorize.mockReturnValueOnce(null);

      expect(() => ipcMain.invoke('app:info', trustedEvent)).toThrow(IpcValidationError);
      expect(authorize).toHaveBeenCalledTimes(2);
    });

    it('asks the policy about the channel being called', () => {
      ipcMain.invoke('history:apps', trustedEvent);

      expect(authorize).toHaveBeenCalledExactlyOnceWith(trustedEvent, 'history:apps');
    });
  });

  describe('invalid arguments', () => {
    it.each<[InvokeChannel, string, unknown[]]>([
      ['history:restore', 'a negative id', [-1]],
      ['history:restore', 'a fractional id', [1.5]],
      ['history:restore', 'a numeric string', ['1']],
      ['history:restore', 'a missing argument', []],
      ['history:apps', 'an unexpected extra argument', ['extra']],
      ['compare:open-clips', 'only one of two ids', [1]],
      ['history:set-pinned', 'a non-boolean flag', [1, 'yes']],
      ['history:delete', 'an array instead of one id', [[1, 2]]],
      ['history:delete-many', 'one id instead of an array', [1]],
      ['history:delete-many', 'an empty list', [[]]],
      ['history:delete-many', 'a duplicate id', [[1, 2, 1]]],
      ['history:delete-many', 'a fractional id', [[1, 2.5]]],
      ['history:delete-many', 'more ids than one batch takes', [range(MAX_BATCH_IDS + 1)]],
      ['history:copy-many', 'an empty list', [[]]],
      ['history:copy-many', 'a duplicate id', [[5, 5]]],
      ['history:copy-many', 'more ids than one batch takes', [range(MAX_BATCH_IDS + 1)]],
      ['history:set-pinned-many', 'a missing flag', [[1, 2]]],
      ['history:set-pinned-many', 'a duplicate id', [[3, 3], true]],
      ['history:set-pinned-many', 'an empty list', [[], false]],
      ['history:clear', 'an unknown option', [{ keepPinned: true, force: true }]],
      ['history:query', 'an unknown query key', [{ sql: 'DROP TABLE clips' }]],
      ['history:query', 'an unknown kind', [{ kind: 'video' }]],
      ['history:query', 'an unknown category', [{ category: 'malware' }]],
      ['history:query', 'a limit above the maximum page size', [{ limit: 501 }]],
      ['history:query', 'an overlong search text', [{ text: 'x'.repeat(501) }]],
      ['settings:update', 'maxClips below the minimum', [{ maxClips: 1 }]],
      ['settings:update', 'an unknown theme', [{ theme: 'neon' }]],
      [
        'settings:update',
        'an accent that is not a hex colour',
        [{ accentColor: 'url(javascript:alert(1))' }],
      ],
      ['diagnostics:report-error', 'a report without "where"', [{ message: 'boom' }]],
    ])('rejects %s with %s', (channel, _label, args) => {
      expect(() => ipcMain.invoke(channel, trustedEvent, ...args)).toThrow(
        new RegExp(`^Invalid arguments for ${channel}: `),
      );
      expect(handlers[channel]).not.toHaveBeenCalled();
    });

    it('accepts a batch of distinct ids up to the cap, and passes it on unchanged', () => {
      const ids = range(MAX_BATCH_IDS);
      ipcMain.invoke('history:delete-many', trustedEvent, ids);
      ipcMain.invoke('history:set-pinned-many', trustedEvent, [4, 2], true);

      expect(handlers['history:delete-many']).toHaveBeenCalledExactlyOnceWith(ids, PALETTE);
      expect(handlers['history:set-pinned-many']).toHaveBeenCalledExactlyOnceWith(
        [4, 2],
        true,
        PALETTE,
      );
    });

    it('throws an IpcValidationError that is a real Error with its own name', () => {
      let thrown: unknown;
      try {
        ipcMain.invoke('history:restore', trustedEvent, 0);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(IpcValidationError);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe('IpcValidationError');
    });
  });

  describe('dispose', () => {
    it('removes every registered handler', () => {
      dispose();

      expect(ipcMain.listeners.size).toBe(0);
      expect(ipcMain.removeHandler).toHaveBeenCalledTimes(CHANNELS.length);
    });

    it('allows registering the handlers again afterwards', () => {
      dispose();

      expect(() => registerIpcHandlers(ipcMain, handlers, authorize)).not.toThrow();
    });
  });
});
