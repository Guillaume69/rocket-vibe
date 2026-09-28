# Test feedback, 2026-09-28

What testers of 0.1.0 reported (Linux, Windows, macOS), and where each item
stands. `[x]` done · `[ ]` to do · `[~]` partial. Items marked *mobile* hold
for the Android app too and are fixed there as well.

## Layout

- [x] Small window: messages cropped (images, cards and files kept a fixed width wider than the window)
- [x] Small window: no composer (pushed off the right edge by the same widths)
- [x] Collapsed (one pane) and on the room list: no way back to the open room (forward arrow in the list header)
- [~] Message times cropped at the top: name and time now share a centred baseline; not reproduced on Linux, to check on Windows and macOS
- [ ] Emoji not aligned with the text around them: aligned on Linux (Noto Color Emoji), need a Windows / macOS screenshot
- [x] Emoji button not aligned with the microphone button (now a symbolic icon like its neighbours)
- [x] The play button on videos and YouTube cards is not a circle (drawn)
- [x] No pointer cursor on the call card and the header call button

## Navigation

- [ ] Room list sections cannot be collapsed (*mobile*)
- [x] Mouse back / forward buttons do nothing (also Alt+Left / Alt+Right): thread, list, rooms opened before
- [ ] No button back to the latest message after scrolling up (*mobile*)
- [ ] Up arrow in an empty composer does not edit my last message
- [ ] No easy access to pinned and starred messages (*mobile*)

## Messages

- [ ] Editing happens in a popover, not in place
- [ ] Deleting asks no confirmation
- [ ] No mouse selection across several lines
- [ ] No preview of emoji and mentions on hover
- [ ] The image viewer does not close on a click outside the image
- [ ] Videos: no poster, no controls, no fullscreen; the player pops in on play
- [ ] Files: no Download button; Open fails on Linux outside GNOME
- [ ] Files and images dropped on the window are not sent
- [ ] No spell check
- [ ] No formatting toolbar: a WYSIWYG composer with bold, italic, strike, heading, link, code, quote and lists
- [ ] "Nothing to do with this message" menu on system messages
- [ ] Attachments go out at once: they should wait in the composer as chips (thumbnail, name, size, remove), open a preview on click, and leave with the text (*mobile*)

## Desktop integration

- [ ] No app icon (Linux launcher, Windows, macOS)
- [ ] App id `me.barrut.RocketVibe` differs from mobile's `com.rocketvibe.app`
- [ ] No unread count on the dock / taskbar icon
- [ ] Notifications do not show on Windows and macOS, and nothing in the app tells why
- [ ] Notifications: a click opens the room, not the message; inline reply only on KDE
- [ ] Random crash on Windows, no crash log to look at

## macOS

- [ ] The app feels laggy: plan a SwiftUI view layer over rv-core (UniFFI)

## Mobile only

- [ ] Sharing to the app from a cold start opens the normal view; the second share works,
  and every later launch replays the share until the app is force-closed
