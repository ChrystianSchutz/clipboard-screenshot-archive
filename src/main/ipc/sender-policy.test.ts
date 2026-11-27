import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { InvokeChannel } from '@shared/ipc-contract';
import { isAppDocumentUrl } from '../app/app-document';
import { ipcSchemas } from './schemas';
import { authorizeSender, mayReadScreenshots, type IpcSender } from './sender-policy';

// The real URL policy, not a stub: the same function the app passes in.
const isAppUrl = (url: string): boolean => isAppDocumentUrl(url, 'app://bundle/index.html');
const appUrl = (role: string): string => `app://bundle/index.html#${role}`;

const palette: IpcSender = { role: 'palette', frameUrl: appUrl('palette'), isMainFrame: true };
const compare: IpcSender = { role: 'compare', frameUrl: appUrl('compare'), isMainFrame: true };
const ALL_CHANNELS = Object.keys(ipcSchemas) as InvokeChannel[];

describe('authorizeSender', () => {
  it.each(ALL_CHANNELS)('lets the palette call %s', (channel) => {
    expect(authorizeSender(palette, channel, isAppUrl)).toEqual({ role: 'palette' });
  });

  it.each<InvokeChannel>([
    'compare:get-state',
    'compare:reset',
    'settings:get',
    'window:hide',
    'app:info',
    'diagnostics:report-error',
  ])('lets the compare window call %s', (channel) => {
    expect(authorizeSender(compare, channel, isAppUrl)).toEqual({ role: 'compare' });
  });

  it.each<InvokeChannel>([
    'history:query',
    'history:delete',
    'history:clear',
    'history:restore',
    'settings:update',
    'compare:open-clips',
    'screenshot:analyze',
    'screenshot:retry-text',
    'screenshot:download-model',
  ])('keeps the compare window away from %s', (channel) => {
    expect(authorizeSender(compare, channel, isAppUrl)).toBeNull();
  });

  it('accepts only a clip id for the screenshot Retry action', () => {
    const schema = ipcSchemas['screenshot:retry-text'];
    expect(schema.safeParse([42]).success).toBe(true);
    expect(schema.safeParse(['42']).success).toBe(false);
    expect(schema.safeParse([42, 'extra']).success).toBe(false);
  });

  it('rejects web contents that are not one of our windows', () => {
    expect(authorizeSender({ ...palette, role: null }, 'app:info', isAppUrl)).toBeNull();
  });

  it('rejects a subframe, even one showing the app document', () => {
    expect(authorizeSender({ ...palette, isMainFrame: false }, 'app:info', isAppUrl)).toBeNull();
  });

  it('rejects a frame that is already gone', () => {
    expect(authorizeSender({ ...palette, frameUrl: null }, 'app:info', isAppUrl)).toBeNull();
  });

  it('rejects our own window after it navigated to another local file', () => {
    const otherFile = pathToFileURL(join(tmpdir(), 'downloaded.html')).href;

    expect(
      authorizeSender({ ...palette, frameUrl: otherFile }, 'history:clear', isAppUrl),
    ).toBeNull();
  });

  it('rejects a remote page', () => {
    const remote = { ...palette, frameUrl: 'https://evil.example/' };

    expect(authorizeSender(remote, 'history:query', isAppUrl)).toBeNull();
  });
});

describe('mayReadScreenshots', () => {
  it('lets only the palette read screenshot pixels, like the screenshot channels', () => {
    expect(mayReadScreenshots('palette')).toBe(true);
    expect(mayReadScreenshots('compare')).toBe(false);
    expect(mayReadScreenshots(null)).toBe(false);
    expect(authorizeSender(compare, 'screenshot:details', isAppUrl)).toBeNull();
    expect(authorizeSender(palette, 'screenshot:details', isAppUrl)).not.toBeNull();
  });
});
