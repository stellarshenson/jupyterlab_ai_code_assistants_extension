import { LabIcon } from '@jupyterlab/ui-components';

// Shared panel chrome icons. Provider icons are NOT here - each provider
// carries its own SVG on its descriptor and the registry builds the LabIcon
// from it, so adding an assistant touches no core file.
//
// Material-style glyphs matched to the rest of the sidebar so header and menu
// icons render at identical size and theme.

const ICON_PREFIX = 'jupyterlab_ai_code_assistants_extension';

// The extension's own identity, used by the settings entry - one section for
// all assistants, so it cannot borrow any one assistant's glyph. Material
// "smart_toy" outline.
const assistantsSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zm-2 10H6V7h12v12zM9 13.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm7.5-1.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5.67-1.5 1.5-1.5 1.5.67 1.5 1.5zM8 15h8v2H8v-2z"/>
</svg>`;

export const assistantsIcon = new LabIcon({
  name: `${ICON_PREFIX}:assistants`,
  svgstr: assistantsSvgStr
});

const starFilledSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M12 2.5l2.9 6.4 7 .7-5.3 4.7 1.6 6.9L12 17.7l-6.2 3.5 1.6-6.9-5.3-4.7 7-.7z"/>
</svg>`;

export const starFilledIcon = new LabIcon({
  name: `${ICON_PREFIX}:star-filled`,
  svgstr: starFilledSvgStr
});

const refreshSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
</svg>`;

export const refreshIcon = new LabIcon({
  name: `${ICON_PREFIX}:refresh`,
  svgstr: refreshSvgStr
});

const removeSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4h-3.5z"/>
</svg>`;

export const removeIcon = new LabIcon({
  name: `${ICON_PREFIX}:remove`,
  svgstr: removeSvgStr
});

// Marks the unsafe launch variants. A shield reads as "protected", which is
// the inverse of what these entries do, so the caution triangle carries them
// instead. Material "warning" outline.
//
// 16x16 and `jp-icon-warn0`, like every other icon in these menus and unlike
// them in colour: authored at 13x13 in `jp-icon3` it rendered smaller than
// its neutral siblings AND in the identical grey, measured rgb(97,97,97) in
// the light theme and rgb(189,189,189) in the dark one - the one glyph whose
// whole job is to say "this differs" was the least conspicuous in the menu.
const warningSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <path class="jp-icon-warn0" fill="#f57c00" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
</svg>`;

export const warningIcon = new LabIcon({
  name: `${ICON_PREFIX}:warning`,
  svgstr: warningSvgStr
});

const addSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
</svg>`;

export const addIcon = new LabIcon({
  name: `${ICON_PREFIX}:add`,
  svgstr: addSvgStr
});

// Git-branch glyph (Octicons git-branch-16, MIT) - marks rows carrying
// parallel conversations and the Branch Session entries.
const branchSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628a2.25 2.25 0 0 1-1.5-2.122Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
</svg>`;

export const branchIcon = new LabIcon({
  name: `${ICON_PREFIX}:branch`,
  svgstr: branchSvgStr
});

// Arrow-switch glyph (Octicons arrow-switch-16, MIT) - the switch-and-manage
// submenu.
const switchSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M5.22 14.78a.75.75 0 0 0 1.06-1.06L4.56 12h8.69a.75.75 0 0 0 0-1.5H4.56l1.72-1.72a.75.75 0 0 0-1.06-1.06l-3 3a.75.75 0 0 0 0 1.06l3 3Zm5.56-6.5a.75.75 0 1 1-1.06-1.06l1.72-1.72H2.75a.75.75 0 0 1 0-1.5h8.69L9.72 2.28a.75.75 0 0 1 1.06-1.06l3 3a.75.75 0 0 1 0 1.06l-3 3Z"/>
</svg>`;

export const switchIcon = new LabIcon({
  name: `${ICON_PREFIX}:switch`,
  svgstr: switchSvgStr
});

// Funnel copied verbatim from @jupyterlab/ui-components' `search/filter.svg` -
// the same image the file browser's filter toggle uses. `class="jp-icon3"`
// lets the theme drive the fill, so the source `fill="#FFF"` is inert under
// the standard light/dark themes.
const filterSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 24 24">
  <path fill="#FFF" d="M14 12v7.88c.04.3-.06.62-.29.83a.996.996 0 0 1-1.41 0l-2.01-2.01a.99.99 0 0 1-.29-.83V12h-.03L4.21 4.62a1 1 0 0 1 .17-1.4c.19-.14.4-.22.62-.22h14c.22 0 .43.08.62.22a1 1 0 0 1 .17 1.4L14.03 12z" class="jp-icon3"/>
</svg>`;

export const filterIcon = new LabIcon({
  name: `${ICON_PREFIX}:filter`,
  svgstr: filterSvgStr
});

// Provider glyphs already built, by icon name. LabIcon warns and returns the
// first registration for a duplicate name, so a provider re-registered by a
// live settings toggle must resolve to the icon it built the first time
// rather than construct a second one on every toggle.
const _providerIcons = new Map<string, LabIcon>();

/** Build (or reuse) the LabIcon for a provider's own glyph. */
export function providerIcon(name: string, svgstr: string): LabIcon {
  let icon = _providerIcons.get(name);
  if (!icon) {
    icon = new LabIcon({ name, svgstr });
    _providerIcons.set(name, icon);
  }
  return icon;
}
