import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { UNREAD_BAR_ID, insertUnreadBar,insertNativeUnreadBar } from './unreadBar.ts';

test('native system activity never opens an unread divider',()=>{
  const rows=[{id:'system',authorId:'other',systemType:'room_changed_topic'}];
  assert.equal(insertNativeUnreadBar(rows,'1',new Map([['system','2']]),'me'),rows);
});

/** A minimal message. DESC: build from newest to oldest. */
const m = (id: string, ts: number, authorId: string) => ({ id, ts, authorId });

const ids = (rows: { id: string }[]): string[] => rows.map((l) => l.id);

test('native opening divider uses exact sequence rather than clocks and ignores own and pending messages',()=>{
  const rows=[m('pending',100,'other'),m('newest',200,'other'),m('first',300,'other'),m('own',400,'me'),m('read',500,'other')];
  const positions=new Map([['read','9007199254740992'],['own','9007199254740993'],['first','9007199254740994'],['newest','9007199254740995']]);
  assert.deepEqual(ids(insertNativeUnreadBar(rows,'9007199254740992',positions,'me')),['pending','newest','first',UNREAD_BAR_ID,'own','read']);
  assert.equal(insertNativeUnreadBar(rows,null,positions,'me'),rows);
});

describe('insertUnreadBar', () => {
  test('the bar goes on the OLDEST unread from others: the last occurrence, not the first', () => {
    // DESC: m3 (300) then m2 (200) then m1 (100). Read up to 150: m3 and m2
    // are unread, the older of the two is m2. A `break` on the first match
    // would place the bar under m3, the newest: THE trap.
    const data = [m('m3', 300, 'bob'), m('m2', 200, 'bob'), m('m1', 100, 'bob')];
    const result = insertUnreadBar(data, 150, 'me');
    assert.deepEqual(ids(result), ['m3', 'm2', UNREAD_BAR_ID, 'm1']);
  });

  test('my own messages do not count as unread', () => {
    // I posted m3 after my last read: the bar only lands on someone else's
    // message (m2), not under mine.
    const data = [m('m3', 300, 'me'), m('m2', 200, 'bob'), m('m1', 100, 'bob')];
    assert.deepEqual(ids(insertUnreadBar(data, 150, 'me')), [
      'm3',
      'm2',
      UNREAD_BAR_ID,
      'm1',
    ]);
    // And if the ONLY later message is mine: no bar at all.
    const onlyMe = [m('m3', 300, 'me'), m('m1', 100, 'bob')];
    assert.equal(insertUnreadBar(onlyMe, 150, 'me'), onlyMe);
  });

  test('all unread → the bar under the oldest; all read → no bar, SAME reference', () => {
    const data = [m('m2', 200, 'bob'), m('m1', 100, 'bob')];
    assert.deepEqual(ids(insertUnreadBar(data, 50, 'me')), ['m2', 'm1', UNREAD_BAR_ID]);
    // Same reference: the screen's useMemo must not re-render for nothing.
    assert.equal(insertUnreadBar(data, 300, 'me'), data);
  });

  test('without a read bound (undefined or null), the list comes back AS IS', () => {
    // `undefined`: the `ls` snapshot is not read from the database yet.
    // `null`: subscription without `ls`. Either way, no bar.
    const data = [m('m1', 100, 'bob')];
    assert.equal(insertUnreadBar(data, undefined, 'me'), data);
    assert.equal(insertUnreadBar(data, null, 'me'), data);
  });

  test('exactly at the bound: `ls` is INCLUDED in read (strictly later required)', () => {
    const data = [m('m1', 150, 'bob')];
    assert.equal(insertUnreadBar(data, 150, 'me'), data);
  });

  test('empty list: nothing to do', () => {
    const empty: { id: string; ts: number; authorId: string }[] = [];
    assert.equal(insertUnreadBar(empty, 100, 'me'), empty);
  });

  test('RECORDED: without a uid (null auth), the bar can land above MY messages', () => {
    // Current behaviour, flagged by the audit: an undefined `myUid` cannot
    // exclude anyone, so my own message counts as "someone else's".
    // The test pins it so that the day it is fixed, it is a choice.
    const data = [m('m2', 300, 'me'), m('m1', 100, 'bob')];
    assert.deepEqual(ids(insertUnreadBar(data, 150, undefined)), [
      'm2',
      UNREAD_BAR_ID,
      'm1',
    ]);
  });
});
