import { useEffect } from 'react';
import { BackHandler } from 'react-native';

/**
 * Fait CONSOMMER le back matériel par `action` tant que `actif`.
 *
 * Sans ça, un élément éphémère (panneau emoji, aperçu de pièce jointe) laisse le
 * back traverser jusqu'au routeur : l'écran se ferme alors qu'on voulait juste
 * refermer l'élément. Android empile les gestionnaires et appelle le DERNIER
 * inscrit d'abord — deux éléments ouverts, le plus récent se referme en premier,
 * ce qui est l'ordre attendu.
 */
export function useRetourMateriel(actif: boolean, action: () => void): void {
  useEffect(() => {
    if (!actif) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      action();
      return true;
    });
    return () => sub.remove();
  }, [actif, action]);
}
