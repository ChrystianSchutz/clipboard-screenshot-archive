import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelFetch, MAX_REDIRECTS, nodeModelFileSystem } from './node-model-io';

const redirect = (location: string | null, status = 302): Response =>
  new Response(null, { status, headers: location ? { location } : {} });

function fetchWith(...responses: Response[]) {
  const impl = vi.fn<typeof fetch>();
  for (const response of responses) impl.mockResolvedValueOnce(response);
  return { impl, fetch: createModelFetch(impl) };
}

const signal = new AbortController().signal;

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('createModelFetch (HTTPS on every hop)', () => {
  it('follows HTTPS redirects by hand and resolves relative locations', async () => {
    const { impl, fetch } = fetchWith(
      redirect('https://cdn.example/blob/abc'),
      redirect('/final?sig=1', 307),
      new Response('weights', { status: 200 }),
    );

    const response = await fetch('https://hub.example/model', signal);

    expect(response.ok).toBe(true);
    expect(impl.mock.calls.map(([url]) => url)).toEqual([
      'https://hub.example/model',
      'https://cdn.example/blob/abc',
      'https://cdn.example/final?sig=1',
    ]);
    for (const [, init] of impl.mock.calls) expect(init).toMatchObject({ redirect: 'manual' });
  });

  it('refuses a redirect to plain HTTP before requesting it', async () => {
    const { impl, fetch } = fetchWith(redirect('http://cdn.example/blob'));

    expect((await rejectionOf(fetch('https://hub.example/model', signal))).message).toBe(
      'refusing a non-HTTPS address (http:)',
    );
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-HTTPS first address without any request', async () => {
    const { impl, fetch } = fetchWith();

    expect((await rejectionOf(fetch('http://hub.example/model', signal))).message).toContain(
      'non-HTTPS',
    );
    expect((await rejectionOf(fetch('not a url', signal))).message).toContain('invalid URL');
    expect(impl).not.toHaveBeenCalled();
  });

  it('gives up after too many redirects', async () => {
    const hops = Array.from({ length: MAX_REDIRECTS + 1 }, (_, i) =>
      redirect(`https://cdn.example/${i}`),
    );
    const { impl, fetch } = fetchWith(...hops);

    expect((await rejectionOf(fetch('https://hub.example/model', signal))).message).toBe(
      'too many redirects',
    );
    expect(impl).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it('fails a redirect without a Location header', async () => {
    const { fetch } = fetchWith(redirect(null, 301));

    expect((await rejectionOf(fetch('https://hub.example/model', signal))).message).toBe(
      'HTTP 301 without a Location header',
    );
  });

  it('passes error statuses through for the downloader to report', async () => {
    const { fetch } = fetchWith(new Response('nope', { status: 404 }));

    const response = await fetch('https://hub.example/model', signal);

    expect(response).toMatchObject({ ok: false, status: 404 });
  });
});

describe('nodeModelFileSystem', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('stats files (null when missing), writes atomically and renames over', async () => {
    dir = await mkdtemp(join(tmpdir(), 'model-fs-'));
    const a = join(dir, 'a.bin');
    const b = join(dir, 'b.bin');

    expect(await nodeModelFileSystem.stat(a)).toBeNull();
    await nodeModelFileSystem.writeFile(a, new Uint8Array([1, 2, 3]));
    await utimes(a, 1_000, 1_000);
    expect(await nodeModelFileSystem.stat(a)).toMatchObject({ size: 3, mtimeMs: 1_000_000 });

    await writeFile(b, 'old');
    await nodeModelFileSystem.rename(a, b);
    expect(await nodeModelFileSystem.stat(a)).toBeNull();
    expect([...(await nodeModelFileSystem.readFile(b))]).toEqual([1, 2, 3]);

    await nodeModelFileSystem.remove(b);
    await nodeModelFileSystem.remove(b); // already gone: no error
    expect(await nodeModelFileSystem.stat(b)).toBeNull();
  });

  it('hashes through one descriptor and stamps the bytes it hashed, identity included', async () => {
    dir = await mkdtemp(join(tmpdir(), 'model-fs-'));
    const path = join(dir, 'model.bin');
    const data = new Uint8Array(3 * 1024 * 1024 + 7).map((_, index) => index % 251);
    await writeFile(path, data);

    const hashed = await nodeModelFileSystem.hashFile(path);

    expect(hashed?.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect(hashed?.stamp).toEqual(await nodeModelFileSystem.stat(path));
    expect(await nodeModelFileSystem.hashFile(join(dir, 'missing.bin'))).toBeNull();
  });

  it('gives a same-size replacement with the same mtime another stamp', async () => {
    dir = await mkdtemp(join(tmpdir(), 'model-fs-'));
    const path = join(dir, 'model.bin');
    const other = join(dir, 'other.bin');
    await writeFile(path, 'good weights');
    await utimes(path, 1_000, 1_000);
    const before = await nodeModelFileSystem.stat(path);
    await writeFile(other, 'evil weights');
    await utimes(other, 1_000, 1_000);

    await rename(other, path);
    const after = await nodeModelFileSystem.stat(path);

    expect(after).toMatchObject({ size: before?.size, mtimeMs: before?.mtimeMs });
    expect(after).not.toEqual(before);
  });
});
