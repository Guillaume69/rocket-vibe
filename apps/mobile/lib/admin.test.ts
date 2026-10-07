import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  compareVersions,
  epoch,
  fetchLatestVersion,
  humanBytes,
  latestFromReleases,
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

  test('Rocket.Chat: the latest release tag', () => {
    assert.equal(latestFromReleases('rocketchat', { tag_name: '8.8.1' }), '8.8.1');
    assert.equal(latestFromReleases('rocketchat', { tag_name: '8.9.0-rc.2', prerelease: true }), null);
    assert.equal(latestFromReleases('rocketchat', null), null);
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
