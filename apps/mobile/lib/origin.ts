/**
 * Origine d'une URL web — scheme + authority — et comparaison d'origines.
 *
 * Trois endroits en dépendent, tous du même chantier « ce qui sort du processus
 * est choisi par nous » : le jeton n'est posé que sur une URL de notre serveur
 * (`lib/upload.ts`), la WebView d'appel ne navigue que sur l'origine de la
 * conférence (`app/call/[callId].tsx`), et le push natif ne s'authentifie que
 * vers le serveur d'une session connue (`plugins/with-fcm-deeplink.js`, en
 * Kotlin — même règle, écrite deux fois faute de langage commun).
 *
 * **Pourquoi pas `new URL(u).origin`.** Le `URL` de React Native n'est pas celui
 * de Node : c'est un polyfill à base de regex
 * (`react-native/Libraries/Blob/URL.js`) qui ne LÈVE JAMAIS sur une entrée
 * invalide et dont `origin` rend `''` au lieu de rejeter. Un `try/catch` autour
 * y serait décoratif, et surtout le banc Node validerait un comportement que
 * l'appareil n'a pas — exactement le genre d'écart qui fait passer un test vert
 * sur du code faux. Une regex explicite se comporte pareil des deux côtés.
 *
 * L'autorité est prise TELLE QUELLE, `userinfo` compris : `https://serveur@evil`
 * ne doit surtout pas se réduire à `https://serveur`.
 */

const ORIGINE = /^(https?:\/\/[^/?#]+)/i;

/** Scheme + authority en minuscules, `null` si ce n'est pas une URL web. */
export function originOf(url: string): string | null {
  const m = ORIGINE.exec(url);
  return m === null ? null : m[1]!.toLowerCase();
}

/**
 * Vrai si `url` est servie par `origine`.
 *
 * Surtout PAS `url.startsWith(origine)` : `https://serveur` est un préfixe de
 * `https://serveur.evil.com/x`. On ré-extrait l'origine des deux côtés et on
 * compare les deux chaînes entières — la frontière est alors dans la regex, pas
 * dans une arithmétique d'index qu'on peut rater.
 */
export function sameOrigin(url: string, origine: string): boolean {
  const sienne = originOf(url);
  return sienne !== null && sienne === originOf(origine);
}
