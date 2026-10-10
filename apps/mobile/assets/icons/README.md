# Interface icons

The SVGs `scripts/generate-icons.mjs` turns into `assets/fonts/RocketVibeIcons.ttf`
(`npm run icons:generate`), drawn by `ui/icon.tsx`.

- Every icon but `send.svg` is a GNOME Adwaita symbolic icon, copied unchanged
  from adwaita-icon-theme 50.0 (`Adwaita/symbolic/<category>/<name>-symbolic.svg`,
  https://gitlab.gnome.org/GNOME/adwaita-icon-theme), the theme the desktop app
  draws with. Artwork by the GNOME Project (https://www.gnome.org), under the
  terms of either the GNU LGPL v3 or Creative Commons Attribution-Share Alike
  3.0 United States (`COPYING-adwaita`). The generated font is a derivative of
  these icons and is distributed under the same terms.
- `send.svg` is RocketVibe's: the desktop's send arrow
  (`apps/desktop/crates/rv-gtk/src/widgets.rs`, `send_arrow`) as filled outlines.

To add an icon: copy `<name>-symbolic.svg` from the same release here as
`<name>.svg`, run `npm run icons:generate`, then use `<Icon name="<name>" />`.
The script accepts filled paths only and says which file it cannot draw.
