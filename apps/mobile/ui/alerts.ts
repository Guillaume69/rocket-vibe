/**
 * The options of every `Alert.alert` of the app. Project rule (CLAUDE.md,
 * "Non-negotiable constraints"): a tap outside a modal, or Back, closes it
 * exactly like Cancel, and never runs the confirming or destructive button.
 *
 * Android's `cancelable` dialog closes on an outside tap and on Back, then
 * calls `onDismiss`, never the Cancel button's `onPress`: when Cancel does
 * something (resetting a preview, a pending flag), pass it here too.
 */

import type { AlertOptions } from 'react-native';

export function dismissible(onCancel?: () => void): AlertOptions {
  return onCancel === undefined ? { cancelable: true } : { cancelable: true, onDismiss: onCancel };
}
