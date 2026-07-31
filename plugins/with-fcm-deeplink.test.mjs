/**
 * La chirurgie de configuration du plugin FCM — la seule partie qu'on peut
 * juger sans compiler.
 *
 * Le Kotlin injecté par ce plugin n'est vérifiable que par un `assembleRelease`
 * suivi d'un essai sur l'appareil, c'est admis. Mais deux propriétés PORTEUSES
 * sont du JavaScript ordinaire, et elles étaient jusqu'ici correctes par
 * propriété du gabarit RN 0.86 plutôt que par propriété du plugin :
 *   - `android:priority="1"` sur l'intent-filter du service. Celui d'expo est à
 *     `-1` ; une valeur plus basse ferait router FCM vers expo et rendrait TOUT
 *     le fichier Kotlin inatteignable — sans erreur de build, sans message ;
 *   - l'endroit où atterrissent les `implementation`. La substitution visait la
 *     première occurrence de `dependencies {` quelle que soit sa profondeur.
 *
 * Test en `.mjs` et non en `.ts` : le sujet EST du JavaScript CommonJS chargé
 * par Expo au moment du prebuild. Le transcrire en TypeScript testerait une
 * copie, pas le fichier que l'outil exécute.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import plugin from './with-fcm-deeplink.js';

const { ajouterDependances, ajouterService, echapperXml, stringsXml, CHAINES, SERVICE_CLASS } =
  plugin.chirurgie;

const DEPS = ['com.google.firebase:firebase-messaging:25.0.1', 'androidx.work:work-runtime:2.10.1'];

/** Un app/build.gradle réduit à ce qui compte : un bloc racine, un imbriqué. */
const GRADLE = `apply plugin: "com.android.application"

android {
    defaultConfig {
        applicationId "com.rocketvibe.app"
    }
    buildTypes {
        release {
            // Un bloc INDENTÉ qui contient le mot, pour piéger une regex laxiste.
            dependencies {
                nothing "here"
            }
        }
    }
}

dependencies {
    implementation("com.facebook.react:react-android")
}

apply plugin: 'com.google.gms.google-services'
`;

describe('ajouterDependances', () => {
  it('injecte dans le bloc `dependencies` RACINE, pas dans un bloc imbriqué', () => {
    const sortie = ajouterDependances(GRADLE, DEPS);
    const posRacine = sortie.search(/^dependencies \{/m);
    const posImbrique = sortie.indexOf('nothing "here"');
    for (const dep of DEPS) {
      const pos = sortie.indexOf(`implementation("${dep}")`);
      assert.ok(pos > posRacine, `${dep} devrait suivre le bloc racine`);
      assert.ok(pos > posImbrique, `${dep} ne doit pas être tombé dans le bloc imbriqué`);
    }
  });

  it('déclare chacun des deux artefacts exactement une fois', () => {
    const sortie = ajouterDependances(GRADLE, DEPS);
    for (const dep of DEPS) {
      assert.equal(sortie.split(`implementation("${dep}")`).length - 1, 1);
    }
  });

  it("n'ajoute rien à un second passage (prebuild sans --clean)", () => {
    const une = ajouterDependances(GRADLE, DEPS);
    assert.equal(ajouterDependances(une, DEPS), une);
  });

  it("laisse tranquille un artefact déjà présent dans une AUTRE version", () => {
    // En déclarer une seconde ferait diverger la résolution de version.
    const avec = GRADLE.replace(
      /^dependencies \{/m,
      'dependencies {\n    implementation("androidx.work:work-runtime:2.9.0")',
    );
    const sortie = ajouterDependances(avec, DEPS);
    assert.ok(sortie.includes('androidx.work:work-runtime:2.9.0'));
    assert.ok(!sortie.includes('androidx.work:work-runtime:2.10.1'));
  });

  it('LÈVE si le gradle n’a aucun bloc `dependencies` racine', () => {
    // Le laisser intact renvoyait le diagnostic bien plus loin : une erreur de
    // compilation Kotlin sur une classe Firebase introuvable.
    const sansBloc = GRADLE.replace(/^dependencies \{[\s\S]*?^\}$/m, '');
    assert.ok(!/^dependencies \{/m.test(sansBloc), 'la fixture doit vraiment être privée du bloc');
    assert.throws(() => ajouterDependances(sansBloc, DEPS), /dependencies/);
  });
});

describe('ajouterService', () => {
  it('déclare le service avec la priorité 1 et l’action FCM', () => {
    const application = {};
    ajouterService(application);
    assert.equal(application.service.length, 1);
    const service = application.service[0];
    assert.equal(service.$['android:name'], `.${SERVICE_CLASS}`);
    assert.equal(service.$['android:exported'], 'false');
    // La valeur exacte dont dépend le routage FCM : celle d'expo est à -1.
    assert.equal(service['intent-filter'][0].$['android:priority'], '1');
    assert.equal(
      service['intent-filter'][0].action[0].$['android:name'],
      'com.google.firebase.MESSAGING_EVENT',
    );
  });

  it('ne le déclare pas deux fois', () => {
    const application = {};
    ajouterService(application);
    ajouterService(application);
    assert.equal(application.service.length, 1);
  });

  it('préserve les services déjà déclarés (celui d’expo)', () => {
    const expo = { $: { 'android:name': 'expo.modules.notifications.service.NotificationsService' } };
    const application = { service: [expo] };
    ajouterService(application);
    assert.equal(application.service.length, 2);
    assert.equal(application.service[0], expo);
  });
});

describe('stringsXml', () => {
  it('rend les trois chaînes de la voie native dans les deux langues', () => {
    for (const langue of ['fr', 'en']) {
      const xml = stringsXml(langue);
      for (const [nom, formes] of Object.entries(CHAINES)) {
        assert.ok(
          xml.includes(`<string name="${nom}">`),
          `${nom} manque en ${langue}`,
        );
        assert.ok(xml.includes(formes[langue]), `la forme ${langue} de ${nom} manque`);
      }
    }
  });

  it('échappe l’apostrophe, que le compilateur de ressources refuse nue', () => {
    // Testé sur `echapperXml` et pas sur le rendu des trois chaînes : aucune
    // n'a d'apostrophe aujourd'hui, donc l'assertion sur `stringsXml` passerait
    // même sans échappement — un test vide. La règle vaut pour la PROCHAINE
    // chaîne (« Nouveau message d'Alice » ferait échouer aapt2 au build).
    assert.equal(echapperXml("Message d'Alice"), "Message d\\'Alice");
  });

  it('échappe les entités XML', () => {
    assert.equal(echapperXml('Alice & <b>Bob</b>'), 'Alice &amp; &lt;b&gt;Bob&lt;/b&gt;');
    assert.equal(echapperXml('dit "oui"'), 'dit &quot;oui&quot;');
  });

  it('ne laisse aucune apostrophe nue dans le rendu', () => {
    assert.ok(!/[^\\]'/.test(stringsXml('fr')), 'apostrophe non échappée dans le strings.xml');
  });

  it('produit un document que le compilateur peut lire', () => {
    const xml = stringsXml('en');
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
    assert.equal(xml.split('<resources>').length - 1, 1);
    assert.equal(xml.split('</resources>').length - 1, 1);
  });
});
