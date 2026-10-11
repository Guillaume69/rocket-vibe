import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthorizedMediaCache, type MediaFiles } from './authorizedMediaCache.ts';
import { clearMediaSession, mediaLease, setMediaBearer } from './mediaAuth.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function bench(overrides: Partial<MediaFiles> = {}) {
  const disk = new Map<string, string>();
  let downloads = 0;
  const files: MediaFiles = {
    prepare: async () => {}, mkdir: async () => {},
    download: async (_url, path, headers) => { downloads++; disk.set(path, headers.Authorization!); return 200; },
    move: async (from, to) => { disk.set(to, disk.get(from)!); disk.delete(from); },
    remove: async path => { for (const key of disk.keys()) if (key.startsWith(path)) disk.delete(key); },
    ...overrides,
  };
  return { disk, files, cache: new AuthorizedMediaCache('file:///cache/authorized-media-v2/', 'test-run', files), downloads: () => downloads };
}

test('same URL is isolated per account and completed copies disappear on logout', async () => {
  const b = bench(), origin = 'https://isolation.example', uri = `${origin}/api/v4/files/same`;
  setMediaBearer(origin, 'alice-token', 'alice');
  const alice = mediaLease(origin)!;
  const first = await b.cache.get(alice, uri);
  assert.equal(await b.cache.get(alice, uri), first);
  assert.equal(b.downloads(), 1);
  setMediaBearer(origin, 'bob-token', 'bob');
  await b.cache.close(alice);
  const bob = mediaLease(origin)!;
  const second = await b.cache.get(bob, uri);
  assert.notEqual(first, second);
  assert.equal(b.disk.has(first), false);
  assert.equal(b.disk.get(second), 'Bearer bob-token');
  assert.equal(b.cache.peek(alice, uri), null);
  clearMediaSession(origin, 'bob', 'bob-token');
  await b.cache.close(bob);
  assert.equal(b.disk.size, 0);
});

test('an old download completing after logout cannot republish bytes or erase the new account', async () => {
  const started = deferred<void>(), finish = deferred<void>();
  const b = bench();
  b.files.download = async (_url, path, headers) => {
    if (headers.Authorization === 'Bearer old') { started.resolve(); await finish.promise; }
    b.disk.set(path, headers.Authorization!);
    return 200;
  };
  const origin = 'https://race.example', uri = `${origin}/file`;
  setMediaBearer(origin, 'old', 'alice');
  const old = mediaLease(origin)!;
  const downloading = b.cache.get(old, uri);
  const rejected = assert.rejects(downloading, /closed/);
  await started.promise;
  clearMediaSession(origin, 'alice', 'old');
  await b.cache.close(old);
  setMediaBearer(origin, 'new', 'bob');
  const fresh = await b.cache.get(mediaLease(origin)!, uri);
  finish.resolve();
  await rejected;
  assert.deepEqual([...b.disk.keys()], [fresh]);
  assert.equal(b.cache.peek(old, uri), null);
});

test('logout during the final rename fences the ready copy', async () => {
  const started = deferred<void>(), finish = deferred<void>();
  const b = bench();
  const move = b.files.move;
  b.files.move = async (from, to) => { started.resolve(); await finish.promise; await move(from, to); };
  const origin = 'https://rename.example', uri = `${origin}/file`;
  setMediaBearer(origin, 'token', 'me');
  const lease = mediaLease(origin)!;
  await assert.rejects(b.cache.get(lease, 'https://evil.example/file'), /origin/);
  const rejected = assert.rejects(b.cache.get(lease, uri), /closed/);
  await started.promise;
  clearMediaSession(origin, 'me', 'token');
  await b.cache.close(lease);
  finish.resolve();
  await rejected;
  assert.equal(b.disk.size, 0);
});

test('simultaneous reads share one download, HTTP errors never become ready, unsafe filenames fail', async () => {
  const b = bench();
  const origin = 'https://failure.example', uri = `${origin}/file`;
  setMediaBearer(origin, 'token', 'me');
  const lease = mediaLease(origin)!;
  assert.deepEqual(await Promise.all([b.cache.get(lease, uri), b.cache.get(lease, uri)]), [b.cache.peek(lease, uri), b.cache.peek(lease, uri)]);
  assert.equal(b.downloads(), 1);
  b.files.download = async (_url, path) => { b.disk.set(path, 'error'); return 401; };
  await assert.rejects(b.cache.get(lease, `${uri}/denied`), /401/);
  assert.equal(b.cache.peek(lease, `${uri}/denied`), null);
  assert.equal([...b.disk.values()].includes('error'), false);
  await assert.rejects(b.cache.get(lease, uri, '../escape'), /filename/);
});

test('logout during first-use preparation sends no authenticated request', async () => {
  const started = deferred<void>(), finish = deferred<void>();
  const b = bench({ prepare: async () => { started.resolve(); await finish.promise; } });
  const origin = 'https://preparing.example';
  setMediaBearer(origin, 'token', 'me');
  const lease = mediaLease(origin)!;
  const rejected = assert.rejects(b.cache.get(lease, `${origin}/file`), /closed/);
  await started.promise;
  clearMediaSession(origin, 'me', 'token');
  await b.cache.close(lease);
  finish.resolve();
  await rejected;
  assert.equal(b.downloads(), 0);
});
