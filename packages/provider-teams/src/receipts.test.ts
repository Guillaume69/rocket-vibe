import assert from 'node:assert/strict';
import { test } from 'node:test';

import { teamsReadReceipts } from './receipts.ts';
import { TeamsDirectory, readPositions } from './translate.ts';

test('consumption horizons become each member\'s last read arrival', () => {
  const body = {
    consumptionhorizons: [
      { id: '8:orgid:a', consumptionhorizon: '1793586249089;1793586249674;1793586249033' },
      { id: '8:orgid:b', consumptionhorizon: '0;0;0' },
      { id: '8:orgid:c' },
    ],
  };
  assert.deepEqual(readPositions(body), [{ user_id: '8:orgid:a', root_position: '1793586249089' }]);
  assert.deepEqual(readPositions({}), []);
});

test('a followed room reads its marks, names readers and positions messages', async () => {
  const d = new TeamsDirectory();
  d.remember('8:orgid:a', 'Ada');
  const source = teamsReadReceipts({ readPositions: async () => [{ user_id: '8:orgid:a', root_position: '20' }] }, d);
  let told = 0;
  source.subscribe(() => told++);
  const stop = source.follow('19:c@thread.v2');
  await new Promise((r) => setTimeout(r, 0));
  stop();
  assert.equal(told, 1);
  assert.deepEqual(source.reads('19:c@thread.v2'), [{ user_id: '8:orgid:a', root_position: '20' }]);
  assert.equal(source.memberName('8:orgid:a'), 'Ada');
  assert.equal(source.position('19:c@thread.v2/20'), '20');
  assert.equal(source.position('local-id'), null);
});
