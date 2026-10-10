import assert from 'node:assert/strict';
import { test } from 'node:test';

import { suggestedName } from './discussions.ts';

test("a discussion is named after its message's first line, shortened", () => {
  assert.equal(suggestedName('\n  Release plan \nsecond line'), 'Release plan');
  assert.equal(suggestedName(undefined), '');
  const long = 'x'.repeat(80);
  assert.equal(suggestedName(long), `${'x'.repeat(59)}…`);
});
