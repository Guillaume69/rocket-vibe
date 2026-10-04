/**
 * The ONLY place in the app that calls `Linking.openURL`.
 *
 * The decision ("may this string leave the process?") lives in
 * `lib/externalLink.ts`, where it is testable without a device; only the
 * native call is left here. A single choke point, so that a future card,
 * button or menu that "opens a link" inherits the guard instead of copying it:
 * copying it is how it gets forgotten.
 */

import { Linking } from 'react-native';

import { canLeaveProcess } from '../lib/externalLink.ts';

/**
 * Opens `url` in the system app, if and only if it is web with none of our
 * credentials. Otherwise nothing, silently: the user tapped forged data, there
 * is nothing to tell them.
 */
export function openExternalLink(url: unknown): void {
  if (!canLeaveProcess(url)) return;
  Linking.openURL(url).catch(() => {});
}
