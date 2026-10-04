import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Bottom margin of a native bottom sheet. iOS: never under the home
 * indicator (~34 px). Android keeps its 28 px.
 */
export function useSheetBottomMargin(): number {
  const { bottom } = useSafeAreaInsets();
  return Platform.OS === 'ios' ? Math.max(28, bottom + 12) : 28;
}
