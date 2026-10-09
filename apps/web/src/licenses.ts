import nunito from "../../desktop/crates/rv-gtk/assets/fonts/OFL-Nunito.txt?raw";
import baloo from "../../desktop/crates/rv-gtk/assets/fonts/OFL-Baloo2.txt?raw";
import noto from "./fonts-native/OFL.txt?raw";
import notoBuild from "./fonts-native/LICENSE?raw";
import adwaita from "./icons-native/COPYING?raw";
import adwaitaCC from "./icons-native/COPYING_CCBYSA3?raw";
import adwaitaLGPL from "./icons-native/COPYING_LGPL?raw";
import { thirdParty } from "./third-party.generated";
import cryptoLicenses from "./crypto/wasm/LICENSES.txt?raw";
export const licenses = [
  ["Nunito", nunito],
  ["Baloo 2", baloo],
  ["Noto Color Emoji", noto],
  ["Noto build tools", notoBuild],
  ["Adwaita", adwaita],
  ["Adwaita CC BY-SA", adwaitaCC],
  ["Adwaita LGPL", adwaitaLGPL],
  ["JavaScript dependencies", thirdParty],
  ["WebAssembly crypto dependencies", cryptoLicenses],
]
  .map(([name, text]) => name + "\n\n" + text)
  .join("\n\n");
