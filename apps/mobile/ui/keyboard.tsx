/**
 * Le clavier ne redimensionne plus la fenêtre : l'edge-to-edge (imposé par
 * Android 15+, donc par le SDK 57) neutralise `adjustResize` — le système
 * livre les insets IME et laisse l'app réagir.
 *
 * Le suivi est piloté par la SharedValue de `react-native-keyboard-controller`
 * (`useReanimatedKeyboardAnimation().height`, 0 fermé → -hauteur ouvert),
 * alimentée frame par frame côté natif (`WindowInsetsAnimation`) : le
 * composer SUIT le clavier au lieu de sauter après coup. Même mécanique que
 * duogo, qui a écarté `KeyboardAvoidingView` (offset automatique défaillant) ;
 * les événements `Keyboard` de RN core ont été écartés aussi — uniques et
 * tardifs (`keyboardDidShow`), et amputés de la barre système
 * (`imeInsets.bottom - barInsets.bottom` dans `ReactRootView`).
 *
 * `max(inset bas, hauteur clavier)` : clavier fermé, la marge de la barre de
 * navigation (le contenu passe dessous en edge-to-edge) ; ouvert, sa hauteur
 * pleine — mesurée depuis le bas de la fenêtre, qui est aussi le bas du
 * conteneur d'écran, donc sans mesure de vue ni offset de header. Remplace
 * `SafeAreaView edges={['bottom']}` sur les écrans à saisie ; les autres
 * gardent SafeAreaView.
 */

import { type ReactNode } from 'react';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColors } from './theme.ts';

export function KeyboardAvoidingContainer({ children }: { children: ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { height } = useReanimatedKeyboardAnimation();
  const avoidance = useAnimatedStyle(() => ({
    paddingBottom: Math.max(insets.bottom, -height.value),
  }));
  // Racine d'écran par construction : `flex: 1` et le fond vivent ici, pas
  // en triplet de style recopié à chaque point d'appel.
  return (
    <Animated.View style={[{ flex: 1, backgroundColor: c.background }, avoidance]}>
      {children}
    </Animated.View>
  );
}
