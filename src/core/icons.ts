import { LabIcon } from '@jupyterlab/ui-components';
import * as React from 'react';

// Shared panel chrome icons. Provider icons are NOT here - each provider
// carries its own SVG on its descriptor and the registry builds the LabIcon
// from it, so adding an assistant touches no core file.
//
// Material-style glyphs matched to the rest of the sidebar so header and menu
// icons render at identical size and theme.

const ICON_PREFIX = 'jupyterlab_ai_code_assistants_extension';

// The extension's own identity, used by the settings entry and the Launcher
// section header - one section for all assistants, so it cannot borrow any one
// assistant's glyph. A robot head in the Material filled style: antenna, side
// bolts, eye and mouth cut-outs. One evenodd path, so the cut-outs are holes
// and the theme's `.jp-icon3[fill]` rule recolours the whole glyph at once.
const assistantsSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <path class="jp-icon3" fill="#616161" fill-rule="evenodd" d="M12 1.5a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2ZM11.2 4.7h1.6V7h-1.6ZM7 7h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3ZM2 11h2v5H2ZM20 11h2v5h-2ZM9 10.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6ZM15 10.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6ZM8.6 15.6h6.8a.9.9 0 0 1 0 1.8H8.6a.9.9 0 0 1 0-1.8Z"/>
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

// `Clean Up Parallel Sessions` - deletes several at once, so it wears the
// sweep variant of the trash glyph (Material "delete_sweep"), same family as
// `Remove from ...`'s plain trash but visibly the bulk one (user direction
// 2026-08-11, replacing the shared danger marker it wore under DEF-45).
const cleanupSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M15 16h4v2h-4zm0-8h7v2h-7zm0 4h6v2h-6zM3 18c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2V8H3v10zM14 5h-3l-1-1H6L5 5H2v2h12z"/>
</svg>`;

export const cleanupIcon = new LabIcon({
  name: `${ICON_PREFIX}:cleanup`,
  svgstr: cleanupSvgStr
});

// Marks the unsafe launch variants. The shield is the established marker for
// an action that touches the permission system (the UAC pattern), and it is
// what the reference implementation used; Material "shield" half-fill, kept
// per user direction 2026-08-11 over the earlier caution triangle.
//
// 16x16 like its siblings (DEF-40's size half - authored at 13x13 it
// rendered smaller than every icon beside it), and in the standard `jp-icon3`
// like them too: the user ruled 2026-08-11 that the shield shape alone marks
// the difference, reversing DEF-40's colour half (the orange `jp-icon-warn0`).
const shieldSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
</svg>`;

export const shieldIcon = new LabIcon({
  name: `${ICON_PREFIX}:shield`,
  svgstr: shieldSvgStr
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

/**
 * A provider's tile icon as the Launcher should draw it.
 *
 * The Launcher has no section icon of its own: a category's header is drawn
 * with the FIRST tile's command icon under the `launcherSection` stylesheet
 * preset, and each tile under `launcherCard`. This view of `tile` renders the
 * extension's joint icon under the section preset and `tile` everywhere else,
 * so the header carries no vendor's mark while every tile keeps its own
 * (ACC-LNCH-163).
 *
 * Built the way `LabIcon.bindprops` builds its views - a prototype child of
 * the tile with its own `react` - so `LabIcon.resolve` still recognises it.
 */
export function launcherTileIcon(tile: LabIcon): LabIcon {
  const view: LabIcon = Object.create(tile);
  const react = React.forwardRef<SVGElement, LabIcon.IReactProps>(
    (props, ref) =>
      React.createElement(
        props.stylesheet === 'launcherSection'
          ? assistantsIcon.react
          : tile.react,
        { ...props, ref }
      )
  );
  // `react` is readonly on the type; the view shadows the tile's own.
  Object.defineProperty(view, 'react', { value: react });
  return view;
}
