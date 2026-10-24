import {requireOptionalNativeModule} from 'expo-modules-core';

import type { WhatsAppNative } from '@rocket-vibe/provider-whatsapp/native';

export type { WhatsAppNative };

/** Null outside Android or in a build without the module. */
export const WhatsApp = requireOptionalNativeModule<WhatsAppNative>('WhatsApp');
