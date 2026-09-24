#!/usr/bin/env sh
# Environnement de build Android local pour rocket-vibe.
#
#   source scripts/env.sh
#
# Idempotent : sourcer plusieurs fois n'empile pas les entrées de PATH.
# Surchargeable : RV_JDK_HOME, RV_ANDROID_HOME et RV_ROOT_URL priment sur
# l'auto-détection.

# --- Détection du JDK -------------------------------------------------------
# On interroge javac plutôt que de lire le nom du répertoire : `jdk1.8.0_171`
# contient « 17 » sans être un JDK 17. Le nom n'est pas une preuve de version.
#
# RN 0.86 fixe sourceCompatibility = VERSION_17 et Gradle 9.3.1 accepte
# Java 17 à 24. Le JDK 17 suffit ; le JDK 21 n'est pas requis.
RV_JDK_MIN=17
RV_JDK_MAX=24

# Version majeure annoncée par javac, ou rien.
_rv_java_major() {
  [ -x "$1/bin/javac" ] || return 1
  "$1/bin/javac" -version 2>&1 | sed -n 's/^javac \([0-9][0-9]*\).*/\1/p'
}

# Premier JDK utilisable sous $1, le plus récent d'abord.
# `sort -V` et non `sort -r` : lexicalement, jdk-17.0.9 précède jdk-17.0.19.
# `while read` alimenté par un heredoc et non par un pipe : un pipe crée un
# sous-shell, et _rv_found n'en ressortirait pas.
_rv_pick_jdk() {
  [ -d "$1" ] || return 1
  _rv_found=''
  _rv_cands=$(find "$1" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -Vr)
  [ -n "$_rv_cands" ] || return 1
  while IFS= read -r _rv_d; do
    [ -n "$_rv_d" ] || continue
    _rv_major=$(_rv_java_major "$_rv_d") || continue
    case "$_rv_major" in
      '' | *[!0-9]*) continue ;;
    esac
    if [ "$_rv_major" -ge "$RV_JDK_MIN" ] && [ "$_rv_major" -le "$RV_JDK_MAX" ]; then
      _rv_found=$_rv_d
      break
    fi
  done <<EOF
$_rv_cands
EOF
  [ -n "$_rv_found" ] || return 1
  printf '%s' "$_rv_found"
}

if [ -z "$RV_JDK_HOME" ]; then
  RV_JDK_HOME=$(_rv_pick_jdk "$HOME/android-build") \
    || RV_JDK_HOME=$(_rv_pick_jdk /usr/lib/jvm) \
    || RV_JDK_HOME=''
fi

# --- Détection du SDK Android ----------------------------------------------
if [ -z "$RV_ANDROID_HOME" ]; then
  for _rv_candidate in "$HOME/Android/Sdk" "$HOME/Android/sdk" /opt/android-sdk; do
    if [ -d "$_rv_candidate/platform-tools" ]; then
      RV_ANDROID_HOME="$_rv_candidate"
      break
    fi
  done
fi

# --- Validation -------------------------------------------------------------
# Le test de non-vacuité vient d'abord : sans lui, une variable vide ferait
# porter le test sur le chemin absolu /bin/javac.
if [ -z "$RV_JDK_HOME" ] || [ ! -x "$RV_JDK_HOME/bin/javac" ]; then
  echo "env.sh: aucun JDK $RV_JDK_MIN-$RV_JDK_MAX trouvé. Définis RV_JDK_HOME." >&2
  return 1 2>/dev/null || exit 1
fi
if [ -z "$RV_ANDROID_HOME" ] || [ ! -d "$RV_ANDROID_HOME/platform-tools" ]; then
  echo "env.sh: SDK Android introuvable. Définis RV_ANDROID_HOME." >&2
  return 1 2>/dev/null || exit 1
fi

# --- Export -----------------------------------------------------------------
JAVA_HOME="$RV_JDK_HOME"
ANDROID_HOME="$RV_ANDROID_HOME"
ANDROID_SDK_ROOT="$RV_ANDROID_HOME"
export JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT

# Ajoute au PATH seulement si absent, pour rester idempotent.
_rv_prepend_path() {
  case ":$PATH:" in
    *":$1:"*) ;;
    *) PATH="$1:$PATH" ;;
  esac
}
_rv_prepend_path "$JAVA_HOME/bin"
_rv_prepend_path "$ANDROID_HOME/platform-tools"
_rv_prepend_path "$ANDROID_HOME/emulator"
_rv_prepend_path "$ANDROID_HOME/cmdline-tools/latest/bin"
export PATH

# --- Serveur de développement ----------------------------------------------
# L'IP LAN, et non 10.0.2.2 : un appareil physique doit joindre le serveur,
# et ROOT_URL conditionne les payloads push et les deep links.
# `adb reverse tcp:3000 tcp:3000` couvre l'émulateur.
#
# Recalculée à chaque source : l'IP change (DHCP, VPN, wifi vers ethernet), et
# un ROOT_URL rance pointerait silencieusement sur l'ancien réseau.
# RV_ROOT_URL fige la valeur pour qui en a besoin.
RV_LAN_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p')
export RV_LAN_IP

if [ -n "$RV_ROOT_URL" ]; then
  ROOT_URL="$RV_ROOT_URL"
  export ROOT_URL
elif [ -n "$RV_LAN_IP" ]; then
  ROOT_URL="http://${RV_LAN_IP}:3000"
  export ROOT_URL
else
  # Mieux vaut pas de ROOT_URL du tout qu'un « http://:3000 » silencieux.
  unset ROOT_URL
  echo "env.sh: aucune IP LAN détectée (pas de route par défaut)." >&2
  echo "env.sh: ROOT_URL non défini. Utilise RV_ROOT_URL pour le forcer." >&2
fi

# La clé de signature release, hors du dépôt (plugins/with-signature-release.js).
# Le fichier exporte RV_KEYSTORE, RV_KEYSTORE_PASSWORD, RV_KEY_ALIAS, RV_KEY_PASSWORD.
if [ -f "$HOME/.config/rocket-vibe/signature.env" ]; then
  . "$HOME/.config/rocket-vibe/signature.env"
fi

if [ -n "$RV_ENV_VERBOSE" ]; then
  echo "JAVA_HOME    = $JAVA_HOME ($(_rv_java_major "$JAVA_HOME"))"
  echo "ANDROID_HOME = $ANDROID_HOME"
  echo "ROOT_URL     = ${ROOT_URL:-<non défini>}"
  echo "RV_KEYSTORE  = ${RV_KEYSTORE:-<non défini : pas de build release>}"
fi

# Ne pas polluer le shell interactif appelant.
unset -f _rv_prepend_path _rv_pick_jdk _rv_java_major 2>/dev/null
unset _rv_d _rv_candidate _rv_found _rv_cands _rv_major RV_JDK_MIN RV_JDK_MAX
