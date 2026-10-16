import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { translate } from '../ui/messages.ts';
import { messageTree } from './markdown.ts';
import { localizedReminder, reminderMessage, reminderParts } from './reminder.ts';

const stored = reminderMessage('marc-etienne.barrut', 'https://chat.example.com/team/pl/q1');

describe('reminders', () => {
  test('the stored sentence gives back its username and link', () => {
    assert.deepEqual(reminderParts(stored), { username: 'marc-etienne.barrut', link: 'https://chat.example.com/team/pl/q1' });
    assert.equal(reminderParts('Hi there, nothing to see'), null);
  });

  test('it reads in the app language, any other text unchanged', () => {
    assert.equal(localizedReminder((k, p) => translate('fr', k, p), stored), 'Bonjour, voici votre rappel concernant ce message de @marc-etienne.barrut : https://chat.example.com/team/pl/q1');
    assert.equal(localizedReminder((k, p) => translate('en', k, p), stored), stored);
    assert.equal(localizedReminder((k, p) => translate('fr', k, p), 'plain'), 'plain');
  });

  test('the username stays a mention and the link a link', () => {
    const fr = localizedReminder((k, p) => translate('fr', k, p), stored);
    const inlines = (messageTree(null, fr)?.[0] as { value: { type: string }[] }).value.map((n) => n.type);
    assert.ok(inlines.includes('MENTION_USER'));
    assert.ok(inlines.includes('LINK'));
  });
});
