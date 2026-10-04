import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Marge basse d'une bottom sheet native. iOS : jamais sous l'indicateur
 * d'accueil (~34 px). Android garde ses 28 px.
 */
export function useSheetBottomMargin(): number {
  const { bottom } = useSafeAreaInsets();
  return Platform.OS === 'ios' ? Math.max(28, bottom + 12) : 28;
}
