import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { threadLoadedUnder, markThreadLoaded, forgetLoadedThreads } from './loadedThreads.ts';
import { sessionToken } from './sessionToken.ts';

describe('loadedThreads', () => {
  beforeEach(() => forgetLoadedThreads());

  test('a never-opened thread is not loaded', () => {
    assert.equal(threadLoadedUnder('f1', 3), false);
  });

  test('reopening under the SAME generation: nothing to reload', () => {
    // The waste avoided: `chat.getMessage` then the thread's whole pagination,
    // replayed on EVERY connection setup because `generation` is in the deps.
    markThreadLoaded('f1', 3, sessionToken());
    assert.equal(threadLoadedUnder('f1', 3), true);
  });

  test('after a connection setup, the guard drops', () => {
    markThreadLoaded('f1', 3, sessionToken());
    assert.equal(threadLoadedUnder('f1', 4), false);
  });

  test('threads are independent, and unrelated to rooms', () => {
    markThreadLoaded('f1', 3, sessionToken());
    assert.equal(threadLoadedUnder('f2', 3), false);
  });

  test('end of session: the whole cache is forgotten', () => {
    markThreadLoaded('f1', 3, sessionToken());
    forgetLoadedThreads();
    assert.equal(threadLoadedUnder('f1', 3), false);
  });

  test('a load that COMPLETES after the session ends repopulates nothing', () => {
    const token = sessionToken();
    forgetLoadedThreads();
    markThreadLoaded('f1', 3, token);
    assert.equal(threadLoadedUnder('f1', 3), false);
  });
});
