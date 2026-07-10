import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { actionsPossibles, reglesDepuisReglages } from './actionsMessage.ts';

const regles = {
  editionAutorisee: true,
  minutesBlocageEdition: 5,
  suppressionAutorisee: true,
  minutesBlocageSuppression: 0,
  epinglageAutorise: true,
};

const base = {
  message: { auteurId: 'moi', horodatage: 1_000_000, typeSysteme: null },
  moi: 'moi',
  regles,
  permissions: [] as string[],
  lectureSeule: false,
  maintenant: 1_000_000 + 60_000, // une minute plus tard
};

describe('actionsPossibles', () => {
  test('mon message récent : tout est permis', () => {
    assert.deepEqual(actionsPossibles(base), ['reagir', 'modifier', 'supprimer', 'epingler']);
  });

  test('le DÉLAI d’édition vient des settings, pas des permissions', () => {
    // 6 minutes après, avec BlockEditInMinutes = 5 : plus d'édition —
    // mais la suppression (délai 0 = illimité) reste.
    const tard = { ...base, maintenant: base.message.horodatage + 6 * 60_000 };
    assert.deepEqual(actionsPossibles(tard), ['reagir', 'supprimer', 'epingler']);
  });

  test('`bypass-time-limit-edit-and-delete` rouvre l’édition après le délai', () => {
    const admin = {
      ...base,
      maintenant: base.message.horodatage + 6 * 60_000,
      permissions: ['bypass-time-limit-edit-and-delete'],
    };
    assert.ok(actionsPossibles(admin).includes('modifier'));
  });

  test('`edit-message` permet de modifier le message d’AUTRUI', () => {
    const moderateur = {
      ...base,
      message: { ...base.message, auteurId: 'lui' },
      permissions: ['edit-message'],
    };
    assert.ok(actionsPossibles(moderateur).includes('modifier'));
  });

  test('le message d’AUTRUI ne se modifie ni ne se supprime (sans permission)', () => {
    const autrui = { ...base, message: { ...base.message, auteurId: 'lui' } };
    assert.deepEqual(actionsPossibles(autrui), ['reagir', 'epingler']);
  });

  test('lecture seule : pas de réaction ; message système : rien du tout', () => {
    assert.ok(!actionsPossibles({ ...base, lectureSeule: true }).includes('reagir'));
    assert.deepEqual(
      actionsPossibles({ ...base, message: { ...base.message, typeSysteme: 'uj' } }),
      [],
    );
  });
});

describe('reglesDepuisReglages', () => {
  test('lit les réglages et retombe sur permissif quand ils manquent', () => {
    const r = reglesDepuisReglages([
      { _id: 'Message_AllowEditing', value: true },
      { _id: 'Message_AllowEditing_BlockEditInMinutes', value: 5 },
      { _id: 'Message_AllowDeleting', value: false },
    ]);
    assert.equal(r.minutesBlocageEdition, 5);
    assert.equal(r.suppressionAutorisee, false);
    assert.equal(r.epinglageAutorise, true, 'absent = permis, le serveur tranchera');
  });
});
