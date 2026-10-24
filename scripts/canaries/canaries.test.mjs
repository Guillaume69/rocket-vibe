import assert from 'node:assert/strict';
import { test } from 'node:test';

import { action, body } from './issues.mjs';
import { pick, source } from './lib.mjs';
import { methods } from './slack.mjs';
import { audiences } from './teams.mjs';
import { swRevision } from './whatsapp.mjs';

test('sw.js is read like the engine reads it: the first digits after the key', () => {
  assert.equal(swRevision('self.x={"client_revision":1051605128,"y":2}', 'client_revision'), 1051605128);
  assert.equal(swRevision('var x = {"client_revision": "123456"};', 'client_revision'), 123456);
  assert.equal(swRevision('nothing here', 'client_revision'), null);
  assert.equal(swRevision('client_revision only', 'client_revision'), null);
});

test('what the canaries check is read from the code, today as it stands', () => {
  const slack = methods(source('packages/provider-slack/src/client.ts'));
  assert.ok(slack.includes('rtm.connect') && slack.includes('saved.list'), slack.join(' '));
  const teams = audiences(source('crates/rv-teams/src/auth.rs'));
  assert.equal(teams.length, 6);
  assert.ok(teams.every((a) => a.startsWith('https://')));
  assert.match(pick('crates/rv-whatsapp/wacore/src/version/generated.rs', /WA_WEB_VERSION_STR: &str = "([\d.]+)"/, 'stamp'), /^2\.3000\.\d+$/);
});

test('a value the code no longer carries fails the canary instead of passing it', () => {
  assert.throws(() => pick('crates/rv-teams/src/auth.rs', /NO_SUCH_CONSTANT = "(x)"/, 'a constant'), /cannot read a constant from crates\/rv-teams\/src\/auth\.rs/);
  assert.throws(() => methods('export type Other = 1;'), /cannot read SlackMethod/);
});

test('one issue per provider: opened, commented while broken, closed once green', () => {
  const bad = [{ id: 'x', status: 'broken', detail: 'moved' }];
  const fine = [{ id: 'x', status: 'ok', detail: '' }, { id: 'y', status: 'notice', detail: 'newer' }];
  assert.equal(action(bad, undefined), 'open');
  assert.equal(action(bad, { number: 1 }), 'comment');
  assert.equal(action(fine, { number: 1 }), 'close');
  assert.equal(action(fine, undefined), null);
  assert.match(body('teams', [{ id: 'a', status: 'broken', detail: 'a | b' }], 'https://run'), /\| \*\*broken\*\* \| `a` \| a \\\| b \|/);
});
