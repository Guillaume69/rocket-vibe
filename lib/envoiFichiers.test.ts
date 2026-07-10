import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ErreurValidation,
  MoteurTeleversement,
  lireReglesUpload,
  validerFichier,
  type DepotTeleversements,
  type LigneTeleversement,
} from './envoiFichiers.ts';
import { ClientRest } from './rest.ts';
import type { TransportUpload } from './upload.ts';

describe('validerFichier', () => {
  test('la taille maximale du serveur est respectée AVANT le moindre octet', () => {
    const regles = { tailleMax: 1000, typesAcceptes: null };
    validerFichier(regles, { type: 'image/png', taille: 999 });
    assert.throws(
      () => validerFichier(regles, { type: 'image/png', taille: 1001 }),
      ErreurValidation,
    );
  });

  test('la liste blanche accepte les jokers `image/*`', () => {
    const regles = { tailleMax: null, typesAcceptes: ['image/*', 'application/pdf'] };
    validerFichier(regles, { type: 'image/png', taille: null });
    validerFichier(regles, { type: 'application/pdf', taille: null });
    assert.throws(
      () => validerFichier(regles, { type: 'video/mp4', taille: null }),
      ErreurValidation,
    );
  });

  test('sans réglage, tout passe — le serveur tranchera', () => {
    validerFichier({ tailleMax: null, typesAcceptes: null }, { type: 'x/y', taille: 1e12 });
  });
});

describe('lireReglesUpload', () => {
  test('lit MaxFileSize et MediaTypeWhiteList depuis settings.public', async () => {
    const client = new ClientRest('http://x', {
      fetch: async () =>
        new Response(
          JSON.stringify({
            settings: [
              { _id: 'FileUpload_MaxFileSize', value: 104857600 },
              { _id: 'FileUpload_MediaTypeWhiteList', value: 'image/*, application/pdf' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      dormir: async () => {},
    });
    const regles = await lireReglesUpload(client);
    assert.equal(regles.tailleMax, 104857600);
    assert.deepEqual(regles.typesAcceptes, ['image/*', 'application/pdf']);
  });
});

function fauxDepot() {
  const lignes = new Map<string, LigneTeleversement>();
  const depot: DepotTeleversements = {
    inserer: async (l) => void lignes.set(l.id, { ...l, statut: 'en-attente' }),
    listerAEnvoyer: async () => [...lignes.values()],
    marquerEchec: async (id, erreur) => {
      const l = lignes.get(id);
      if (l) {
        l.statut = 'echec';
        void erreur;
      }
    },
    supprimer: async (id) => void lignes.delete(id),
  };
  return { depot, lignes };
}

function clientConfirmant() {
  return new ClientRest('http://x', {
    fetch: async (url) => {
      const corps = String(url).includes('mediaConfirm')
        ? { success: true, message: { _id: 'm1', rid: 'r1' } }
        : { settings: [] };
      return new Response(JSON.stringify(corps), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    dormir: async () => {},
  });
}

describe('MoteurTeleversement', () => {
  test('persiste AVANT l’envoi, téléverse, confirme, ingère, purge', async () => {
    const { depot, lignes } = fauxDepot();
    const ingeres: unknown[] = [];
    const transport: TransportUpload = async (_url, _entetes, _fichier, surProgression) => {
      surProgression?.(0.5);
      assert.equal(lignes.size, 1, "l'intention est persistée avant que l'octet parte");
      return { statut: 200, corps: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'id-fichier-000000000000',
      ingerer: async (doc) => void ingeres.push(doc),
    });

    await moteur.envoyer('r1', { uri: 'file:///a.png', nom: 'a.png', type: 'image/png', taille: 10 });

    assert.equal(lignes.size, 0, 'purgé au succès');
    assert.equal(ingeres.length, 1, 'le message confirmé repasse par la synchro');
  });

  test('un refus serveur marque `echec`, rejouable', async () => {
    const { depot, lignes } = fauxDepot();
    const transport: TransportUpload = async () => ({
      statut: 413,
      corps: JSON.stringify({ success: false, error: 'trop gros' }),
    });
    const moteur = new MoteurTeleversement({
      depot,
      client: clientConfirmant(),
      transport,
      genererId: () => 'id-fichier-000000000000',
      ingerer: async () => {},
    });
    await moteur.envoyer('r1', { uri: 'file:///a.png', nom: 'a.png', type: 'image/png', taille: 10 });
    assert.equal([...lignes.values()][0]?.statut, 'echec');
  });
});
