/**
 * The "AI Assistants" section header carries the extension's joint icon, not
 * the first assistant's (ACC-LNCH-163).
 *
 * The Launcher has no section icon: it draws a category's header with the
 * first tile's command icon under the `launcherSection` stylesheet preset, and
 * every tile under `launcherCard`. `launcherTileIcon` is the view that tells
 * the two apart, so these cases render it under each preset and compare the
 * markup with the icon the Launcher should have drawn.
 */

// Same stubs as panel.spec.ts: the ui-components barrel reaches two ESM-only
// packages the jest config does not transform, and nothing here renders a
// toolbar or a web component.
jest.mock('@jupyter/react-components', () => ({}));
jest.mock('@jupyter/web-components', () => ({
  addJupyterLabThemeChangeListener: () => undefined,
  applyJupyterTheme: () => undefined,
  jpButton: () => undefined,
  jpToolbar: () => undefined,
  provideJupyterDesignSystem: () => ({ register: () => undefined })
}));

import { LabIcon } from '@jupyterlab/ui-components';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { assistantsIcon, launcherTileIcon, providerIcon } from '../core/icons';
import { PROVIDERS } from '../providers';

type Preset = 'launcherSection' | 'launcherCard';

function markup(icon: LabIcon, stylesheet: Preset): string {
  return renderToStaticMarkup(React.createElement(icon.react, { stylesheet }));
}

const tiles = PROVIDERS.map(module => [
  module.descriptor.id,
  providerIcon(module.descriptor.iconName, module.descriptor.iconSvg)
]) as [string, LabIcon][];

describe('ACC-LNCH-163 - the section header draws the joint icon', () => {
  it.each(tiles)(
    '%s: the joint icon under the section preset, not the tile',
    (_id, tile) => {
      const view = launcherTileIcon(tile);
      expect(markup(view, 'launcherSection')).toBe(
        markup(assistantsIcon, 'launcherSection')
      );
      expect(markup(view, 'launcherSection')).not.toBe(
        markup(tile, 'launcherSection')
      );
    }
  );

  it.each(tiles)('%s: its own glyph on the tile', (_id, tile) => {
    const view = launcherTileIcon(tile);
    expect(markup(view, 'launcherCard')).toBe(markup(tile, 'launcherCard'));
    expect(markup(view, 'launcherCard')).not.toBe(
      markup(assistantsIcon, 'launcherCard')
    );
  });

  it('is a LabIcon the Launcher resolves as itself', () => {
    // `LabIcon.resolveReact` hands anything that is not a LabIcon to a lookup
    // by name, which would return the tile and lose the header branch.
    const view = launcherTileIcon(tiles[0][1]);
    expect(view).toBeInstanceOf(LabIcon);
    expect(LabIcon.resolve({ icon: view })).toBe(view);
  });

  it('the joint icon is not any assistant glyph', () => {
    for (const [, tile] of tiles) {
      expect(assistantsIcon.svgstr).not.toBe(tile.svgstr);
    }
  });
});
