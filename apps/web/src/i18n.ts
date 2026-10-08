const phrases = {
  connect: ["Connect", "Connexion"],
  server: ["Server", "Serveur"],
  username: ["Username or email", "Identifiant ou email"],
  password: ["Password", "Mot de passe"],
  login: ["Sign in", "Se connecter"],
  code: ["Verification code", "Code de vérification"],
  verify: ["Verify", "Vérifier"],
  cancel: ["Cancel", "Annuler"],
  logout: ["Sign out", "Se déconnecter"],
  add: ["Add", "Ajouter"],
  unread: ["Unread", "Non lus"],
  favorites: ["Favourites", "Favoris"],
  channels: ["Channels", "Salons"],
  direct: ["Direct messages", "Messages directs"],
  new: ["New conversation", "Nouvelle conversation"],
  send: ["Send", "Envoyer"],
  message: ["Write a message…", "Écrire un message…"],
  settings: ["Settings", "Paramètres"],
  search: ["Search", "Rechercher"],
  pins: ["Pinned messages", "Messages épinglés"],
  stars: ["Starred messages", "Messages favoris"],
  thread: ["Thread", "Fil de discussion"],
  reply: ["Reply in thread", "Répondre dans un fil"],
  quote: ["Quote", "Citer"],
  edit: ["Edit", "Modifier"],
  delete: ["Delete", "Supprimer"],
  save: ["Save", "Enregistrer"],
  retry: ["Retry", "Réessayer"],
  pin: ["Pin", "Épingler"],
  unpin: ["Unpin", "Désépingler"],
  star: ["Star", "Ajouter aux favoris"],
  unstar: ["Unstar", "Retirer des favoris"],
  react: ["React", "Réagir"],
  copy: ["Copy text", "Copier le texte"],
  loading: ["Loading…", "Chargement…"],
  empty: [
    "Your conversations, a little brighter",
    "Vos conversations, un peu plus lumineuses",
  ],
  emptyHint: [
    "Choose a conversation to start chatting.",
    "Choisissez une conversation pour discuter.",
  ],
  encrypted: ["Encrypted conversation", "Conversation chiffrée"],
  encryptedHint: [
    "Encrypted conversations are not supported in the web client. Open this conversation in the desktop or mobile app.",
    "Les conversations chiffrées ne sont pas prises en charge sur le web. Ouvrez cette conversation dans l’application desktop ou mobile.",
  ],
  online: ["Connected", "Connecté"],
  connecting: ["Connecting", "Connexion"],
  offline: ["Offline", "Hors ligne"],
  profile: ["Profile", "Profil"],
  appearance: ["Appearance", "Apparence"],
  security: ["Security", "Sécurité"],
  notifications: ["Notifications", "Notifications"],
  sessions: ["Devices and sessions", "Appareils et sessions"],
  language: ["Language", "Langue"],
  name: ["Display name", "Nom affiché"],
  bio: ["About me", "À propos de moi"],
  status: ["Status", "Statut"],
  statusText: ["Status message", "Message de statut"],
  people: ["People", "Personnes"],
  rooms: ["Rooms", "Salons"],
  create: ["Create", "Créer"],
  join: ["Join", "Rejoindre"],
  private: ["Private room", "Salon privé"],
  topic: ["Topic", "Sujet"],
  description: ["Description", "Description"],
  announcement: ["Announcement", "Annonce"],
  members: ["Members", "Membres"],
  leave: ["Leave conversation", "Quitter la conversation"],
  download: ["Download", "Télécharger"],
  attach: ["Attach a file", "Joindre un fichier"],
  voice: ["Record a voice message", "Enregistrer un message vocal"],
  stop: ["Stop recording", "Arrêter l’enregistrement"],
  older: ["Load older messages", "Charger les messages précédents"],
  all: ["All messages", "Tous les messages"],
  mention: ["Mentions only", "Mentions seulement"],
  nothing: ["None", "Aucune"],
  notificationsEnable: [
    "Enable browser notifications",
    "Activer les notifications du navigateur",
  ],
  failed: ["Not sent", "Non envoyé"],
  pending: ["Sending…", "Envoi…"],
  size: ["Text size", "Taille du texte"],
  clock: ["24-hour clock", "Horloge sur 24 heures"],
  roomInfo: ["Room information", "Informations du salon"],
  details: ["Details", "Détails"],
  close: ["Close", "Fermer"],
  reconnect: ["Reconnect", "Reconnecter"],
  admin: ["Administration", "Administration"],
  general: ["Overview", "Vue d’ensemble"],
  reports: ["Reports", "Signalements"],
  readOnly: [
    "This conversation is read-only.",
    "Cette conversation est en lecture seule.",
  ],
  signup: ["Create an account", "Créer un compte"],
  invitation: ["Invitation code", "Code d’invitation"],
  recovery: ["Recover my account", "Récupérer mon compte"],
  recoveryCode: ["Recovery code", "Code de récupération"],
  noResults: ["No results", "Aucun résultat"],
  email: ["Email", "Email"],
  totp: ["Authenticator", "Application d’authentification"],
  recovery_code: ["Recovery code", "Code de récupération"],
  markRead: ["Mark as read", "Marquer comme lu"],
  today: ["Today", "Aujourd’hui"],
  yesterday: ["Yesterday", "Hier"],
  newMessages: ["New messages", "Nouveaux messages"],
  slogan: [
    "A little magic in your conversations",
    "Un peu de magie dans vos conversations",
  ],
} as const;
export let language = resolveLanguage(
  (typeof localStorage !== "undefined"
    ? localStorage.getItem("rv-language")
    : null) || "auto",
);
function resolveLanguage(value: string): string {
  return value === "auto"
    ? (typeof navigator !== "undefined" ? navigator.language : "en").startsWith(
        "fr",
      )
      ? "fr"
      : "en"
    : value === "fr"
      ? "fr"
      : "en";
}
export function setLanguage(value: string): void {
  language = resolveLanguage(value);
  localStorage.setItem("rv-language", value === "auto" ? "auto" : language);
  document.documentElement.lang = language;
}
export const t = (key: keyof typeof phrases): string =>
  phrases[key][language === "fr" ? 1 : 0];
