import { describe, expect, it, vi } from 'vitest';
import { screenshotUrl } from '@shared/screenshots';

const handlers = vi.hoisted(() => ({
  palette: null as
    ((request: { url: string; method: string }) => Promise<Response> | Response) | null,
  compare: null as
    ((request: { url: string; method: string }) => Promise<Response> | Response) | null,
}));

vi.mock('electron', () => ({
  protocol: {
    handle: (_scheme: string, handler: typeof handlers.palette) => {
      handlers.palette = handler;
    },
  },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      protocol: {
        handle: (_scheme: string, handler: typeof handlers.compare) => {
          handlers.compare = handler;
        },
      },
    }),
  },
}));

const { screenshotResponse, serveScreenshotProtocol } = await import('./screenshot-protocol');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('screenshotResponse', () => {
  it('serves the PNG of an image clip by id and variant, uncached and unsniffable', async () => {
    const read = vi.fn(() => Promise.resolve(PNG));

    const response = await screenshotResponse(
      { url: screenshotUrl(12, 'thumb'), method: 'GET' },
      read,
    );

    expect(read).toHaveBeenCalledExactlyOnceWith(12, 'thumb');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it('answers 404 for a clip that is not an image, or whose file cannot be read', async () => {
    const missing = await screenshotResponse({ url: screenshotUrl(3, 'full'), method: 'GET' }, () =>
      Promise.resolve(null),
    );
    const broken = await screenshotResponse({ url: screenshotUrl(3, 'full'), method: 'GET' }, () =>
      Promise.reject(new Error('ENOENT')),
    );

    expect(missing.status).toBe(404);
    expect(broken.status).toBe(404);
  });

  it.each([
    ['a path instead of a clip id', 'clip-image://clip/../../secrets.png'],
    ['an unknown variant', 'clip-image://clip/1/original'],
    ['another host', 'clip-image://evil/1/full'],
    ['a query', 'clip-image://clip/1/full?path=C:/x.png'],
    ['another scheme', 'file:///C:/images/a.png'],
  ])('refuses %s without reading anything', async (_label, url) => {
    const read = vi.fn(() => Promise.resolve(PNG));

    const response = await screenshotResponse({ url, method: 'GET' }, read);

    expect(response.status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it('allows only GET', async () => {
    const read = vi.fn(() => Promise.resolve(PNG));

    const response = await screenshotResponse(
      { url: screenshotUrl(1, 'full'), method: 'POST' },
      read,
    );

    expect(response.status).toBe(405);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('serveScreenshotProtocol', () => {
  it('serves images in the palette session and refuses them in the compare session', async () => {
    const read = vi.fn(() => Promise.resolve(PNG));
    serveScreenshotProtocol(read);
    const request = { url: screenshotUrl(5, 'full'), method: 'GET' };

    const palette = await handlers.palette?.(request);
    const compare = await handlers.compare?.(request);

    expect(palette?.status).toBe(200);
    expect(compare?.status).toBe(403);
    expect(read).toHaveBeenCalledExactlyOnceWith(5, 'full');
  });
});
