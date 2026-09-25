import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Pont du module natif Kotlin, autolinké par Expo depuis `modules/`. Android
 * seulement : sous iOS le module vaut `null`. Importable QUE dans l'app : sous Node, `requireNativeModule` jette.
 */

type TelechargementsNatif = {
  /**
   * Copie un fichier LOCAL (`file://…`) dans le dossier public Téléchargements.
   * Rend l'URI de l'entrée créée. Un nom déjà pris est suffixé par le système.
   */
  enregistrer(source: string, nom: string, type: string | null): Promise<string>;
};

export const Telechargements = requireOptionalNativeModule<TelechargementsNatif>('Telechargements');
