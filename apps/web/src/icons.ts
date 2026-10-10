import searchIcon from "./icons-native/system-search-symbolic.svg";
import addIcon from "./icons-native/list-add-symbolic.svg";
import attachIcon from "./icons-native/mail-attachment-symbolic.svg";
import micIcon from "./icons-native/audio-input-microphone-symbolic.svg";
import smileIcon from "./icons-native/face-smile-symbolic.svg";
import settingsIcon from "./icons-native/preferences-system-symbolic.svg";
import logoutIcon from "./icons-native/system-log-out-symbolic.svg";
import pinIcon from "./icons-native/view-pin-symbolic.svg";
import backIcon from "./icons-native/go-previous-symbolic.svg";
import closeIcon from "./icons-native/window-close-symbolic.svg";
import videoIcon from "./icons-native/camera-video-symbolic.svg";
import profileIcon from "./icons-native/avatar-default-symbolic.svg";
import notificationsIcon from "./icons-native/preferences-system-notifications-symbolic.svg";
import languageIcon from "./icons-native/preferences-desktop-locale-symbolic.svg";
import securityIcon from "./icons-native/security-high-symbolic.svg";
import devicesIcon from "./icons-native/computer-symbolic.svg";
import appIcon from "./icons-native/emblem-system-symbolic.svg";
import adminIcon from "./icons-native/network-server-symbolic.svg";
import usersIcon from "./icons-native/system-users-symbolic.svg";
import arrowIcon from "./icons-native/go-next-symbolic.svg";
import imageIcon from "./icons-native/image-x-generic-symbolic.svg";
import editIcon from "./icons-native/document-edit-symbolic.svg";
import copyIcon from "./icons-native/edit-copy-symbolic.svg";
import refreshIcon from "./icons-native/view-refresh-symbolic.svg";
import playIcon from "./icons-native/media-playback-start-symbolic.svg";
import pauseIcon from "./icons-native/media-playback-pause-symbolic.svg";
import volumeIcon from "./icons-native/audio-volume-high-symbolic.svg";
import headphonesIcon from "./icons-native/audio-headphones-symbolic.svg";
import screenIcon from "./icons-native/video-display-symbolic.svg";
import leaveIcon from "./icons-native/call-stop-symbolic.svg";
import downloadIcon from "./icons-native/folder-download-symbolic.svg";
import moderationIcon from "./icons-native/dialog-warning-symbolic.svg";
import roomsIcon from "./icons-native/chat-message-new-symbolic.svg";
import botsIcon from "./icons-native/system-run-symbolic.svg";
import workflowsIcon from "./icons-native/media-playlist-repeat-symbolic.svg";
import upIcon from "./icons-native/go-up-symbolic.svg";
import downIcon from "./icons-native/go-down-symbolic.svg";
import trashIcon from "./icons-native/user-trash-symbolic.svg";
import panUpIcon from "./icons-native/pan-up-symbolic.svg";
import micMutedIcon from "./icons-native/microphone-disabled-symbolic.svg";
import volumeMutedIcon from "./icons-native/audio-volume-muted-symbolic.svg";
import cameraWebIcon from "./icons-native/camera-web-symbolic.svg";
import volumeLowIcon from "./icons-native/audio-volume-low-symbolic.svg";
import fullscreenIcon from "./icons-native/view-fullscreen-symbolic.svg";
import restoreIcon from "./icons-native/view-restore-symbolic.svg";
import openFileIcon from "./icons-native/document-open-symbolic.svg";
import stopIcon from "./icons-native/media-playback-stop-symbolic.svg";
import lockIcon from "./icons-native/channel-secure-symbolic.svg";
import audioFileIcon from "./icons-native/audio-x-generic-symbolic.svg";
import textFileIcon from "./icons-native/text-x-generic-symbolic.svg";
const native: Record<string, string> = {
  lock: lockIcon,
  "audio-file": audioFileIcon,
  "text-file": textFileIcon,
  fullscreen: fullscreenIcon,
  restore: restoreIcon,
  "open-file": openFileIcon,
  stop: stopIcon,
  camera: cameraWebIcon,
  "volume-low": volumeLowIcon,
  "audio-menu": panUpIcon,
  "mic-muted": micMutedIcon,
  "volume-muted": volumeMutedIcon,
  bots: botsIcon,
  workflows: workflowsIcon,
  up: upIcon,
  down: downIcon,
  trash: trashIcon,
  headphones: headphonesIcon,
  screen: screenIcon,
  "leave-call": leaveIcon,
  download: downloadIcon,
  moderation: moderationIcon,
  rooms: roomsIcon,
  play: playIcon,
  pause: pauseIcon,
  volume: volumeIcon,
  profile: profileIcon,
  notifications: notificationsIcon,
  language: languageIcon,
  security: securityIcon,
  devices: devicesIcon,
  app: appIcon,
  admin: adminIcon,
  users: usersIcon,
  arrow: arrowIcon,
  image: imageIcon,
  edit: editIcon,
  copy: copyIcon,
  refresh: refreshIcon,
  search: searchIcon,
  plus: addIcon,
  attach: attachIcon,
  mic: micIcon,
  smile: smileIcon,
  settings: settingsIcon,
  logout: logoutIcon,
  pin: pinIcon,
  back: backIcon,
  close: closeIcon,
  video: videoIcon,
};
import { button } from "./dom";
const paths: Record<string, string> = {
  plus: "M8 3v10M3 8h10",
  search: "M10.8 10.8l3.7 3.7M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
  send: "M8 14.5v-13M2.5 7l5.5-5.5L13.5 7",
  attach: "m6 10 5-5a2 2 0 0 1 3 3l-6 6a4 4 0 0 1-6-6l6-6",
  mic: "M6 3a2 2 0 0 1 4 0v5a2 2 0 0 1-4 0V3ZM3 7v1a5 5 0 0 0 10 0V7M8 13v2M5 15h6",
  smile: "M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0ZM5 6h.01M11 6h.01M5 10q3 4 6 0",
  settings: "M3 3h10v10H3V3ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  logout: "M6 2H2v12h4M5 8h10m-4-4 4 4-4 4",
  pin: "m5 2 6 0-1 5 3 3H3l3-3-1-5ZM8 10v5",
  back: "m10 3-5 5 5 5",
  close: "m4 4 8 8M12 4l-8 8",
  more: "M3 8h.01M8 8h.01M13 8h.01",
  video: "M2 4h8v8H2V4Zm8 3 4-2v6l-4-2",
  arrow: "m5 3 6 5-6 5",
  bold: "M5 2h4a3 3 0 0 1 0 6H5V2Zm0 6h5a3 3 0 0 1 0 6H5V8",
  italic: "M7 2h6M3 14h6M10 2 6 14",
  quote: "M2 4h5v5H3l-1 4M9 4h5v5h-4l-1 4",
  code: "m5 4-4 4 4 4m6-8 4 4-4 4",
  star: "m8 1 2 4 5 .8-3.5 3.5.9 5L8 12l-4.4 2.3.9-5L1 5.8 6 5l2-4",
};
export function icon(name: string): SVGSVGElement | HTMLSpanElement {
  if (native[name]) {
    const node = document.createElement("span");
    node.className = "symbolic-icon";
    node.style.maskImage = "url(" + JSON.stringify(native[name]) + ")";
    node.setAttribute("aria-hidden", "true");
    return node;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[name] || paths.more);
  for (const [key, value] of Object.entries({
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  }))
    path.setAttribute(key, value);
  svg.append(path);
  return svg;
}

export function iconSource(name: string): { mask?: string; path?: string } {
  return native[name]
    ? { mask: native[name] }
    : { path: paths[name] || paths.more };
}
export function iconButton(
  name: string,
  label: string,
  action: () => void | Promise<void>,
  className = "flat",
): HTMLButtonElement {
  const node = button("", action, className);
  node.title = label;
  node.setAttribute("aria-label", label);
  node.append(icon(name));
  return node;
}
