/**
 * Choix d'une photo de profil : ouvre le sélecteur d'images natif, laisse
 * RECADRER en carré (`allowsEditing` + `aspect [1,1]`) — un avatar est toujours
 * carré — et compresse. Rend un `FichierAEnvoyer` prêt pour `users.setAvatar`,
 * ou `null` si l'utilisateur annule.
 *
 * Le photo picker Android moderne ne demande AUCUNE permission d'accès à la
 * galerie (il tourne hors du bac à sable de l'app), donc pas de garde ici.
 */

import * as ImagePicker from 'expo-image-picker';

import type { FileToSend } from '../lib/upload.ts';
import { launchPickerWithRetry } from './launchPicker.ts';

export async function pickAvatar(): Promise<FileToSend | null> {
  const res = await launchPickerWithRetry(() =>
    ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      // 0.7 : un avatar est affiché petit ; inutile de téléverser du plein format.
      quality: 0.7,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    }),
  );
  if (res.canceled || res.assets.length === 0) return null;
  const a = res.assets[0]!;
  const type = a.mimeType ?? 'image/jpeg';
  // Extension cohérente avec le MIME : le serveur se fie parfois au nom.
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  return { uri: a.uri, name: a.fileName ?? `avatar.${ext}`, type };
}
