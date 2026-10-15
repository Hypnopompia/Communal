# ADR 0025 — App icon: hexagon Venn, Icon Composer and adaptive Android

- Status: accepted (the owner picked the mark from four concepts).
- Date: 2026-10-15

The old mark was three overlapping discs on a near-white tile. It had two platform problems:

- **macOS:** the tile was always white, so in a dark Dock it stood out next to apps that use macOS 26's Icon Composer icons, which switch to a dark look on their own.
- **Android:** `ic_launcher` was a plain vector drawable, not an adaptive icon, so the launcher shrank it and put it inside a white circle.

## Decision

**The mark** is three overlapping pointy-top hexagons (blue, green, amber), two above and one below like the old discs. Each overlap has its own colour, and the part all three share is white: the Venn of three people's shelves. `apps/desktop/scripts/icons.mjs` is the single source. It flattens the rounded hexagons into polygons and cuts the overlaps exactly, because Android vectors have no clip paths. Every output is made from those regions, so they all match.

**macOS** gets an Icon Composer document, `build/icon.icon`. Each part of the Venn is its own layer, and the hexagons have glass. The fill is light in the light look and navy in the dark one, and macOS makes the clear and tinted looks from the layers. electron-builder 26 compiles it with `actool` into `Assets.car`, and makes an `.icns` for older macOS. The `.icns` we made ourselves with `iconutil` is gone. **Packaging the Mac app now needs Xcode 26** (`actool` 26+), which the release machine has. To check a change, `ictool` inside Icon Composer.app renders any look, e.g. `--rendition Dark`.

**Windows, Linux, the window icon and the site** use a plain tile on Apple's 1024 grid. It's navy, so it sits with dark taskbars, and it doesn't change with the theme.

**Android** gets an adaptive icon, `mipmap-anydpi-v26/ic_launcher.xml` (minSdk is 30, so no bitmap fallbacks):

- background: the navy gradient
- foreground: the mark, kept inside a 31 dp radius so no launcher mask cuts it
- monochrome: the three outlines and a solid core, for Android 13+ themed icons

**The macOS tray** template, that monochrome icon and the Android notification icon (`ic_stat_communal`) use the same outline form.

**The inline mark** (the renderer's `Mark`, the site headers) leaves the shared core see-through, so it works on light and dark pages. Its paths are copied from `build/mark.svg`, which the script writes.

## Alternatives considered

The four concepts were a hexagon Venn (chosen), a faceted gem (flat-top hexagons merging into one outline), woven hexagon rings (a Borromean link), and a honeycomb with nodes. The woven rings were the runner-up. They lose the weave below 32 px.
