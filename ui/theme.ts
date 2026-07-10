/**
 * Palette de l'application, déclinée claire/sombre.
 *
 * Elle vivait dans chaque écran ; à trois copies, une teinte corrigée dans un
 * fichier ne l'était plus dans les autres. Un seul point de vérité, résolu par
 * `useCouleurs()` selon le thème du système — pas de bascule maison.
 */

import { useColorScheme } from 'react-native';

export const couleursClaires = {
  fond: '#ffffff',
  carte: '#f4f4f5',
  carteErreur: '#fee2e2',
  texte: '#18181b',
  texteErreur: '#991b1b',
  attenue: '#71717a',
  bordure: '#d4d4d8',
  accent: '#2563eb',
  ondulation: '#1d4ed8',
};

export type Couleurs = typeof couleursClaires;

export const couleursSombres: Couleurs = {
  fond: '#09090b',
  carte: '#18181b',
  carteErreur: '#450a0a',
  texte: '#fafafa',
  texteErreur: '#fca5a5',
  attenue: '#a1a1aa',
  bordure: '#3f3f46',
  accent: '#3b82f6',
  ondulation: '#1d4ed8',
};

export function useCouleurs(): Couleurs {
  return useColorScheme() === 'dark' ? couleursSombres : couleursClaires;
}
