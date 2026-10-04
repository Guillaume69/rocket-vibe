import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RestClient } from './rest.ts';
import {
  confirmMedia,
  setAvatar,
  UploadError,
  uploadBytes,
  avatarUrl,
  protectedFileUrl,
  type TransportUpload,
} from './upload.ts';

function authenticatedClient(postResponses: Record<string, unknown>) {
  const posts: { path: string; body: unknown }[] = [];
  const client = new RestClient('http://x', {
    fetch: async (url, init) => {
      const path = String(url).split('/api/v1/')[1] ?? '';
      posts.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(postResponses[path] ?? { success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  client.auth = { authToken: 'jeton-alice', userId: 'uid-alice' };
  return { client, posts };
}

const file = { uri: 'file:///x/mini.png', name: 'mini.png', type: 'image/png' };

describe('uploadBytes', () => {
  test('posts to rooms.media, authenticated, and returns the fileId WITHOUT confirming anything', async () => {
    const calls: string[] = [];
    const transport: TransportUpload = async (url, headers) => {
      calls.push(url);
      assert.equal(headers['X-Auth-Token'], 'jeton-alice', 'the upload is authenticated');
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' }, success: true }) };
    };
    const { client, posts } = authenticatedClient({});

    const fileId = await uploadBytes({ client, transport, rid: 'r1', file });

    assert.deepEqual(calls, ['http://x/api/v1/rooms.media/r1']);
    assert.equal(fileId, 'f1', 'THIS is what gets persisted before going further');
    assert.equal(posts.length, 0, 'the two steps are kept separate');
  });

  test('a rooms.media refusal is a clear error', async () => {
    const transport: TransportUpload = async () => ({
      status: 413,
      body: JSON.stringify({ success: false, error: 'File too large' }),
    });
    const { client, posts } = authenticatedClient({});
    await assert.rejects(
      uploadBytes({ client, transport, rid: 'r1', file }),
      (e: unknown) => e instanceof UploadError && e.message === 'File too large',
    );
    assert.equal(posts.length, 0);
  });

  test('a non-JSON response (reverse proxy) does not crash with a TypeError', async () => {
    const transport: TransportUpload = async () => ({ status: 502, body: '<html>bad gateway' });
    const { client } = authenticatedClient({});
    await assert.rejects(uploadBytes({ client, transport, rid: 'r1', file }), UploadError);
  });

  test('the task interrupter is handed up to the caller', async () => {
    let cancel: (() => Promise<void>) | null = null;
    let canceled = false;
    const transport: TransportUpload = async (_u, _e, _f, _p, onCancelable) => {
      onCancelable?.(async () => void (canceled = true));
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const { client } = authenticatedClient({});
    await uploadBytes({
      client,
      transport,
      rid: 'r1',
      file,
      onCancelable: (a) => void (cancel = a),
    });
    assert.notEqual(cancel, null, 'without it, "Discard" would only be a DELETE');
    await (cancel as unknown as () => Promise<void>)();
    assert.ok(canceled);
  });
});

describe('confirmMedia', () => {
  test('mediaConfirm is what CREATES the message; rooms.media alone leaves an orphan', async () => {
    const { client, posts } = authenticatedClient({
      'rooms.mediaConfirm/r1/f1': { success: true, message: { _id: 'm1', rid: 'r1' } },
    });
    const message = await confirmMedia({ client, rid: 'r1', fileId: 'f1', message: 'légende' });
    assert.equal(posts[0]?.path, 'rooms.mediaConfirm/r1/f1');
    assert.deepEqual(posts[0]?.body, { msg: 'légende' });
    assert.equal(message._id, 'm1');
  });

  test('without a caption, the body is EMPTY (additionalProperties: false)', async () => {
    const { client, posts } = authenticatedClient({
      'rooms.mediaConfirm/r1/f1': { success: true, message: { _id: 'm1' } },
    });
    await confirmMedia({ client, rid: 'r1', fileId: 'f1' });
    assert.deepEqual(posts[0]?.body, {}, 'the server would reject any extra key');
  });

  test('a confirmation without a message is an error, not a silent success', async () => {
    const { client } = authenticatedClient({ 'rooms.mediaConfirm/r1/f1': { success: true } });
    await assert.rejects(confirmMedia({ client, rid: 'r1', fileId: 'f1' }), UploadError);
  });
});

describe('setAvatar', () => {
  test('posts to users.setAvatar, authenticated', async () => {
    let seenUrl = '';
    const transport: TransportUpload = async (url, headers) => {
      seenUrl = url;
      assert.equal(headers['X-Auth-Token'], 'jeton-alice', 'the avatar upload is authenticated');
      return { status: 200, body: JSON.stringify({ success: true }) };
    };
    const { client } = authenticatedClient({});
    await setAvatar({ client, transport, file });
    assert.equal(seenUrl, 'http://x/api/v1/users.setAvatar');
  });

  test('a server refusal becomes a clear UploadError', async () => {
    const transport: TransportUpload = async () => ({
      status: 400,
      body: JSON.stringify({ success: false, error: 'Avatar change disabled' }),
    });
    const { client } = authenticatedClient({});
    await assert.rejects(
      setAvatar({ client, transport, file }),
      (e: unknown) => e instanceof UploadError && e.message === 'Avatar change disabled',
    );
  });

  test('a non-JSON response does not crash with a TypeError', async () => {
    const transport: TransportUpload = async () => ({ status: 502, body: '<html>' });
    const { client } = authenticatedClient({});
    await assert.rejects(setAvatar({ client, transport, file }), UploadError);
  });
});

describe('protectedFileUrl', () => {
  test('adds rc_uid and rc_token, which FileUpload_ProtectFiles requires', () => {
    const { client } = authenticatedClient({});
    assert.equal(
      protectedFileUrl(client, '/file-upload/f1/mini.png'),
      'http://x/file-upload/f1/mini.png?rc_uid=uid-alice&rc_token=jeton-alice',
    );
  });

  test('respects an existing query', () => {
    const { client } = authenticatedClient({});
    assert.match(protectedFileUrl(client, '/file-upload/f1/x.png?a=1'), /\?a=1&rc_uid=/);
  });

  test('an ABSOLUTE path to another host does NOT get the token', () => {
    // `title_link` comes from a message's `attachments`, which `chat.sendMessage`
    // accepts as is: a forged absolute link left from here with rc_uid and
    // rc_token stuck on it, and an `<Image>` delivered them to that host.
    const { client } = authenticatedClient({});
    const url = protectedFileUrl(client, 'https://evil.example/collecte.png');
    assert.equal(url, 'https://evil.example/collecte.png');
    assert.ok(!url.includes('rc_token'));
  });

  test('a host that ours is a prefix of is still another host', () => {
    const { client } = authenticatedClient({});
    assert.ok(!protectedFileUrl(client, 'http://x.evil.example/f.png').includes('rc_token'));
  });

  test('a userinfo imitating our host gets nothing either', () => {
    const { client } = authenticatedClient({});
    assert.ok(!protectedFileUrl(client, 'http://x@evil.example/f.png').includes('rc_token'));
  });

  test('an absolute URL to OUR server stays authenticated', () => {
    const { client } = authenticatedClient({});
    assert.match(protectedFileUrl(client, 'http://x/file-upload/f1/x.png'), /rc_token=jeton-alice/);
  });
});

describe('avatarUrl', () => {
  test('targets by uid, authenticated, as Accounts_AvatarBlockUnauthenticatedAccess requires', () => {
    const { client } = authenticatedClient({});
    assert.equal(
      avatarUrl(client, { uid: 'u123' }),
      'http://x/avatar/uid/u123?rc_uid=uid-alice&rc_token=jeton-alice',
    );
  });

  test('a username wins over the uid, and is encoded', () => {
    const { client } = authenticatedClient({});
    assert.match(avatarUrl(client, { username: 'a b', uid: 'u1' }) ?? '', /\/avatar\/a%20b\?/);
  });

  test('a channel targets /avatar/room/<rid>', () => {
    const { client } = authenticatedClient({});
    assert.match(avatarUrl(client, { rid: 'GENERAL' }) ?? '', /\/avatar\/room\/GENERAL\?/);
  });

  test('returns null if nothing designates a target; the caller keeps its tile', () => {
    const { client } = authenticatedClient({});
    assert.equal(avatarUrl(client, { uid: null, username: '', rid: undefined }), null);
  });

  test('the photo version goes into the URI, otherwise the image cache freezes it forever', () => {
    // The server ignores the parameter; it targets Android's CACHE. Without it,
    // `/avatar/alice` stays identical after a photo change and the old image
    // shows forever (no HTTP ETag on the server side, observed on 8.5).
    const { client } = authenticatedClient({});
    const before = avatarUrl(client, { username: 'alice', etag: 'e1' });
    const after = avatarUrl(client, { username: 'alice', etag: 'e2' });
    assert.match(before ?? '', /\/avatar\/alice\?etag=e1&rc_uid=/);
    assert.notEqual(before, after, 'a new version must give a new URI');
  });

  test('without a known version, the URI stays as before: nothing regresses', () => {
    const { client } = authenticatedClient({});
    assert.equal(
      avatarUrl(client, { username: 'alice', etag: null }),
      avatarUrl(client, { username: 'alice' }),
    );
  });

  test('a room version is encoded too', () => {
    const { client } = authenticatedClient({});
    assert.match(avatarUrl(client, { rid: 'r 1', etag: 'a/b' }) ?? '', /\/avatar\/room\/r%201\?etag=a%2Fb&/);
  });
});
