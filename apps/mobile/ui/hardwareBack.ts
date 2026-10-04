import { useEffect } from 'react';
import { BackHandler } from 'react-native';

/**
 * Makes `action` CONSUME the hardware back while `active`.
 *
 * Without it, a transient element (emoji panel, attachment preview) lets back
 * through to the router: the screen closes when the intent was only to close
 * the element. Android stacks handlers and calls the LAST registered first:
 * with two elements open, the most recent closes first, which is the expected order.
 */
export function useHardwareBack(active: boolean, action: () => void): void {
  useEffect(() => {
    if (!active) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      action();
      return true;
    });
    return () => sub.remove();
  }, [active, action]);
}
