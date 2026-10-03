# Preuves publiques E2EE

Formats et vérificateurs extraits de `rv-crypto` et partagés sans copie avec le
serveur. Cette crate appartient au workspace racine ; le coffre client conserve
son workspace et son lock propres. Elle contient racine publique, certificat,
révocation, demande d'appareil et grant, avec leurs cadrages signés inchangés.

Aucune clé privée, récupération, persistance ou décision de confiance n'y est
stockée. Une signature valide ne vaut ni pin confirmé, ni consentement humain,
ni accès au groupe. Les clients gardent ces décisions dans `rv-crypto`.
Les fonctions de cadrage publiques servent aussi aux signatures locales ; elles
ne signent rien et n'acceptent aucun secret.

Les vecteurs et tests de non-régression restent dans
[`rv-crypto`](../rv-crypto/README.md). Le serveur teste séparément les preuves
réelles, leurs liaisons à la session et le cycle des KeyPackages.
