import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Bridge to the Kotlin module (`android/…/ExactAlarmsModule.kt`), autolinked by
 * Expo from `modules/`. Android only: `null` on iOS and in a dev client built
 * before the module existed. Importable ONLY in the app: under Node,
 * expo-modules-core does not load.
 */

type NativeExactAlarms = {
  /** Whether the system grants this app exact alarms (always true before Android 12). */
  canSchedule(): boolean;
  /** Opens the system's "Alarms and reminders" screen for this app; false if it could not. */
  openSettings(): boolean;
};

export const ExactAlarms = requireOptionalNativeModule<NativeExactAlarms>('ExactAlarms');
