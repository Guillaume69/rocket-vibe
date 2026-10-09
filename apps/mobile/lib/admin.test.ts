import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  compareVersions,
  emojiCodes,
  adminRefusalKey,
  epoch,
  fetchLatestVersion,
  humanBytes,
  latestFromReleases,
  mapLimited,
  verdictCache,
  type ProviderAdmin,
  nextOffset,
  parseVersion,
  reportReason,
  updateStatus,
  uptimeParts,
} from './admin.ts';

describe('versions', () => {
  test('reads plain, v-prefixed and server tags, refuses pre-releases', () => {
    assert.deepEqual(parseVersion('8.8.1'), [8, 8, 1]);
    assert.deepEqual(parseVersion('v8.8.1'), [8, 8, 1]);
    assert.deepEqual(parseVersion('server-v0.3.0'), [0, 3, 0]);
    assert.equal(parseVersion('8.9.0-rc.1'), null);
    assert.equal(parseVersion('mobile-v1.0.0'), null);
  });

  test('compares numerically, part by part', () => {
    assert.ok(compareVersions('8.10.0', '8.9.9') > 0);
    assert.ok(compareVersions('8.5', '8.5.1') < 0);
    assert.equal(compareVersions('v8.5.1', '8.5.1'), 0);
  });

  test('update status: newer, same or older, unknown', () => {
    assert.equal(updateStatus('8.5.1', '8.8.1'), 'available');
    assert.equal(updateStatus('8.5.1', '8.5.1'), 'current');
    assert.equal(updateStatus('8.9.0', '8.8.1'), 'current');
    assert.equal(updateStatus('8.5.1', null), null);
    assert.equal(updateStatus('dev', '8.8.1'), null);
  });

  test('Rocket.Chat: the highest release of the list, not the GitHub "latest" (a backport)', () => {
    const releases = [
      { tag_name: '7.10.9' }, // a backport published last
      { tag_name: '8.9.0-rc.2', prerelease: true },
      { tag_name: '8.8.1' },
      { tag_name: '8.10.0', draft: true },
    ];
    assert.equal(latestFromReleases('rocketchat', releases), '8.8.1');
    assert.equal(latestFromReleases('rocketchat', null), null);
  });

  test('RocketVibe: an -rc server tag is no release', () => {
    assert.equal(latestFromReleases('rocketvibe', [{ tag_name: 'server-v0.4.0-rc.1' }, { tag_name: 'server-v0.3.0' }]), '0.3.0');
  });

  test('RocketVibe: the highest server tag, app tags and drafts ignored', () => {
    const releases = [
      { tag_name: 'mobile-v1.4.0' },
      { tag_name: 'server-v0.2.0' },
      { tag_name: 'server-v0.10.0' },
      { tag_name: 'server-v0.11.0', draft: true },
      { tag_name: 'desktop-v2.0.0' },
    ];
    assert.equal(latestFromReleases('rocketvibe', releases), '0.10.0');
    assert.equal(latestFromReleases('rocketvibe', [{ tag_name: 'mobile-v1.4.0' }]), null);
  });

  test('a failed fetch is unknown, never an error', async () => {
    assert.equal(await fetchLatestVersion('rocketchat', async () => { throw new Error('offline'); }), null);
    assert.equal(await fetchLatestVersion('rocketchat', async () => ({ ok: false, json: async () => ({}) })), null);
    const urls: string[] = [];
    const latest = await fetchLatestVersion('rocketvibe', async (url) => {
      urls.push(url);
      return { ok: true, json: async () => [{ tag_name: 'server-v1.2.3' }] };
    });
    assert.equal(latest, '1.2.3');
    assert.match(urls[0]!, /Guillaume69\/rocket-vibe\/releases/);
  });
});

describe('verdictCache', () => {
  const fakeAdmin = (answers: (boolean | Error)[]) => {
    let asked = 0;
    const admin = {
      isAdmin: async () => {
        const a = answers[asked++]!;
        if (a instanceof Error) throw a;
        return a;
      },
    } as unknown as ProviderAdmin;
    return { admin, asked: () => asked };
  };

  test('asked once per provider and generation, again on a new generation', async () => {
    const verdict = verdictCache();
    const one = fakeAdmin([true, false]);
    assert.equal(await verdict(one.admin, 0), true);
    assert.equal(await verdict(one.admin, 0), true);
    assert.equal(one.asked(), 1);
    assert.equal(await verdict(one.admin, 1), false);
    assert.equal(one.asked(), 2);
    const other = fakeAdmin([false]);
    assert.equal(await verdict(other.admin, 0), false);
  });

  test('a failure is not kept', async () => {
    const verdict = verdictCache();
    const one = fakeAdmin([new Error('offline'), true]);
    await assert.rejects(verdict(one.admin, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(await verdict(one.admin, 0), true);
    assert.equal(one.asked(), 2);
  });
});

describe('mapLimited', () => {
  test('keeps the order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimited([5, 1, 4, 2, 3], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30]);
    assert.equal(peak, 2);
    assert.deepEqual(await mapLimited([], 8, async () => 1), []);
  });
});

describe('formatting helpers', () => {
  test('bytes in the largest unit that keeps a number >= 1', () => {
    assert.equal(humanBytes(200), '200 B');
    assert.equal(humanBytes(1536), '1.5 KB');
    assert.equal(humanBytes(50 * 1024 * 1024), '50 MB');
    assert.equal(humanBytes(3 * 1024 ** 3, ['o', 'Ko', 'Mo', 'Go']), '3.0 Go');
  });

  test('uptime in days, hours, minutes', () => {
    assert.deepEqual(uptimeParts(3107.7), { days: 0, hours: 0, minutes: 51 });
    assert.deepEqual(uptimeParts(2 * 86400 + 3 * 3600 + 120), { days: 2, hours: 3, minutes: 2 });
  });

  test('dates and offsets', () => {
    assert.equal(epoch('2026-10-07T18:51:51.051Z'), Date.UTC(2026, 9, 7, 18, 51, 51, 51));
    assert.equal(epoch('nope'), null);
    assert.equal(epoch(null), null);
    assert.equal(nextOffset(0, 50, 120), '50');
    assert.equal(nextOffset(100, 20, 120), null);
    assert.equal(nextOffset(0, 0, 10), null);
  });

  test('a report reason is trimmed, required and bounded', () => {
    assert.equal(reportReason('  spam  '), 'spam');
    assert.equal(reportReason('   '), null);
    assert.equal(reportReason('x'.repeat(1001)), null);
    assert.equal(reportReason('x'.repeat(1000))?.length, 1000);
  });
});

describe('custom emoji codes', () => {
  test('trims colons and spaces, drops empty aliases', () => {
    assert.deepEqual(emojiCodes(' :party_parrot: ', 'rv_parrot, ,vibe-parrot'), {
      name: 'party_parrot',
      aliases: ['rv_parrot', 'vibe-parrot'],
    });
  });
  test('refuses what a server would rewrite, repeats and more than 8 aliases', () => {
    for (const [name, aliases] of [['', ''], ['Bad Name', ''], ['ok', 'ok'], ['ok', 'a,b,c,d,e,f,g,h,i'], ['é', '']]) {
      assert.equal(emojiCodes(name!, aliases!), 'admin.emojiErrorName', `${name} ${aliases}`);
    }
  });
  test('never a standard emoji code', () => {
    assert.equal(emojiCodes('smile', ''), 'admin.emojiErrorReserved');
    assert.equal(emojiCodes('mine', 'thumbsup'), 'admin.emojiErrorReserved');
  });
  test('both servers refusals have their words', () => {
    assert.equal(adminRefusalKey('Custom_Emoji_Error_Name_Or_Alias_Already_In_Use'), 'admin.emojiErrorTaken');
    assert.equal(adminRefusalKey('revision_conflict'), 'admin.emojiErrorTaken');
    assert.equal(adminRefusalKey('emoji-is-not-image'), 'admin.emojiErrorImage');
    assert.equal(adminRefusalKey('emoji_name_reserved'), 'admin.emojiErrorReserved');
    assert.equal(adminRefusalKey('session_rejected'), null);
    // The same generic refusal reads as the icon's on the icon card.
    assert.equal(adminRefusalKey('invalid_request'), 'admin.emojiErrorName');
    assert.equal(adminRefusalKey('invalid_request', 'icon'), 'admin.iconErrorImage');
  });
});
