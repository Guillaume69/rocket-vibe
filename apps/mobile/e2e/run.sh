#!/usr/bin/env bash
# Suite E2E Maestro (8.8) : login, envoi, reconnexion, upload, 2FA.
#
#   MAESTRO=/chemin/vers/maestro e2e/run.sh
#
# Maestro s'installe depuis la release GitHub officielle (PAS le
# curl | bash) : https://github.com/mobile-dev-inc/maestro/releases
# → maestro.zip, décompresser, pointer MAESTRO sur bin/maestro.
#
# Prérequis : AVD démarré, app installée (build dev + Metro), Rocket.Chat
# local (docker compose up), `adb reverse` posés par scripts/env.sh.
# Chaque flow est indépendant ; le harnais orchestre l'état entre deux
# (coupure du lien, 2FA de bob, fichier poussé). En bash : la boucle de
# travail interdit de compter sur zsh ici (globs, découpage).
set -euo pipefail

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RACINE="$(dirname "$ICI")"
MAESTRO="${MAESTRO:-maestro}"
SERVEUR="${SERVEUR:-http://localhost:3000}"
# TOUJOURS l'émulateur : un téléphone personnel branché ne doit jamais
# recevoir la suite par accident.
export ANDROID_SERIAL="${ANDROID_SERIAL:-emulator-5554}"
MAESTRO_ARGS=(--device "$ANDROID_SERIAL")
HORODATAGE="$(date +%s)"
FICHIER_SECRET="/tmp/rocket-vibe-e2e-2fa-secret"

# Le dev-client crashe parfois en natif (SIGSEGV Fabric,
# `MountingCoordinator::pullTransaction`, mesuré ~2 démarrages sur 8) au
# premier chargement du bundle après `clearState` — jamais en release (0/8),
# jamais une fois l'app lancée. Apparu avec reanimated 4.5 (8.9) ; en
# attendant un correctif amont, les flows qui partent d'un état VIERGE ont
# droit à un second essai. Pas les autres : rejouer 02/04 reposterait le
# même message.
maestro_retry_froid() {
  if ! "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$@"; then
    echo "   (second essai : crash connu du dev-client au démarrage à froid)"
    "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$@"
  fi
}

# Un run précédent interrompu a pu laisser la 2FA de bob active — les flows
# 03 et 05 en dépendent : on nettoie d'ENTRÉE avec le secret persisté.
if [ -s "$FICHIER_SECRET" ]; then
  node "$ICI/harness/two-factor.mjs" disable "$(cat "$FICHIER_SECRET")" || true
  rm -f "$FICHIER_SECRET"
fi

echo "== 01 connexion (alice)"
maestro_retry_froid "$ICI/flows/01-login.yaml" \
  -e SERVEUR="$SERVEUR" -e UTILISATEUR=alice -e MOT_DE_PASSE=alice-dev-2026

echo "== 02 envoi"
"$MAESTRO" "${MAESTRO_ARGS[@]}" test "$ICI/flows/02-send.yaml" -e MSG="e2e-envoi-$HORODATAGE"
# L'assert Maestro serait satisfait par le rendu OPTIMISTE seul : la
# vérité vient du serveur.
node "$ICI/harness/check-server.mjs" "e2e-envoi-$HORODATAGE"

echo "== 03 reconnexion (coupure du lien pendant que bob poste)"
# Quoi qu'il arrive entre la coupure et la fin, le lien est RÉTABLI :
# sans ce trap, un échec au milieu laisserait l'émulateur hors ligne.
retablir_lien() { adb reverse tcp:3000 tcp:3000 >/dev/null 2>&1 || true; }
trap retablir_lien EXIT
adb reverse --remove tcp:3000 || true
node "$ICI/harness/post-as-bob.mjs" "e2e-reconnexion-$HORODATAGE"
sleep 8
retablir_lien
trap - EXIT
"$MAESTRO" "${MAESTRO_ARGS[@]}" test "$ICI/flows/03-reconnect.yaml" -e MSG="e2e-reconnexion-$HORODATAGE"

echo "== 04 upload (picker système)"
FICHIER="e2e-image-$HORODATAGE.png"
# Un PNG 1×1 valide, généré localement — rien à versionner.
printf '\x89PNG\r\n\x1a\n' > "/tmp/$FICHIER"
python3 - "$FICHIER" <<'PY'
import struct, sys, zlib
nom = sys.argv[1]
def bloc(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
donnees = zlib.compress(b'\x00\xff\x00\x00')
png = b'\x89PNG\r\n\x1a\n' + bloc(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) \
    + bloc(b'IDAT', donnees) + bloc(b'IEND', b'')
open(f'/tmp/{nom}', 'wb').write(png)
PY
adb push "/tmp/$FICHIER" "/sdcard/Download/$FICHIER" >/dev/null
adb shell cmd media scan "/sdcard/Download/$FICHIER" >/dev/null 2>&1 || true
"$MAESTRO" "${MAESTRO_ARGS[@]}" test "$ICI/flows/04-upload.yaml" \
  -e LEGENDE="e2e-upload-$HORODATAGE" -e FICHIER="$FICHIER"
# L'assert Maestro peut matcher la légende encore dans le COMPOSER : la
# vérité (message + fichier joint) vient du serveur.
node "$ICI/harness/check-server.mjs" "e2e-upload-$HORODATAGE" --fichier

echo "== 05 deux facteurs (TOTP sur bob)"
SECRET="$(node "$ICI/harness/two-factor.mjs" enable)"
printf '%s' "$SECRET" > "$FICHIER_SECRET"
nettoyer_2fa() { node "$ICI/harness/two-factor.mjs" disable "$SECRET" || true; }
trap nettoyer_2fa EXIT
# Le retry recalcule son TOTP : celui du premier essai serait périmé (et
# Rocket.Chat refuse la RÉUTILISATION d'un code déjà consommé).
if ! "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$ICI/flows/05-two-factor.yaml" \
  -e SERVEUR="$SERVEUR" -e MOT_DE_PASSE=bob-dev-2026 \
  -e TOTP="$(node "$ICI/harness/totp.mjs" "$SECRET" +30)"; then
  echo "   (second essai : crash connu du dev-client au démarrage à froid)"
  "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$ICI/flows/05-two-factor.yaml" \
    -e SERVEUR="$SERVEUR" -e MOT_DE_PASSE=bob-dev-2026 \
    -e TOTP="$(node "$ICI/harness/totp.mjs" "$SECRET" +30)"
fi
trap - EXIT
# Le nettoyage FINAL n'est pas optionnel : un disable raté avec un secret
# perdu bloque tous les runs suivants (le || true du trap ne couvre que le
# chemin d'ÉCHEC de la suite, où l'erreur d'origine prime).
node "$ICI/harness/two-factor.mjs" disable "$SECRET"
rm -f "$FICHIER_SECRET"

echo "== remise en état : session alice"
maestro_retry_froid "$ICI/flows/01-login.yaml" \
  -e SERVEUR="$SERVEUR" -e UTILISATEUR=alice -e MOT_DE_PASSE=alice-dev-2026

echo "SUITE E2E VERTE ($RACINE)"
