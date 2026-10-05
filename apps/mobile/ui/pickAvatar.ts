/**
 * Picks a profile photo: opens the native image picker, lets the user CROP
 * to a square (`allowsEditing` + `aspect [1,1]`), as an avatar is always
 * square, and compresses. Returns a `FileToSend` ready for `users.setAvatar`,
 * or `null` if the user cancels.
 *
 * The modern Android photo picker asks for NO gallery access permission (it
 * runs outside the app's sandbox), hence no guard here.
 */

import * as ImagePicker from 'expo-image-picker';
import {manipulateAsync,SaveFormat} from 'expo-image-manipulator';

import type { FileToSend } from '../lib/upload.ts';
import { launchPickerWithRetry } from './launchPicker.ts';

export async function pickAvatar(native=false): Promise<FileToSend | null> {
  const res = await launchPickerWithRetry(() =>
    ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      // 0.7: an avatar is shown small; no point uploading full size.
      quality: 0.7,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    }),
  );
  if (res.canceled || res.assets.length === 0) return null;
  const a = res.assets[0]!;
  if(native){
    const image=await manipulateAsync(a.uri,[{resize:{width:Math.min(512,a.width||512),height:Math.min(512,a.height||512)}}],{format:SaveFormat.PNG});
    return {uri:image.uri,name:'avatar.png',type:'image/png'};
  }
  const type = a.mimeType ?? 'image/jpeg';
  // Extension consistent with the MIME: the server sometimes trusts the name.
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  return { uri: a.uri, name: a.fileName ?? `avatar.${ext}`, type };
}
