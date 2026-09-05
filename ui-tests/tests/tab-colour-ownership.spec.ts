import { expect, test } from '@jupyterlab/galata';

import { waitForApplication } from './shared';

/**
 * The companion version floor, announced once per page.
 *
 * Tab colour capture is now a signal the companion extension emits when the
 * user picks a colour, replacing the scrape of its browser storage that made a
 * dead terminal's colour permanent (DEF-COLO-155). A companion older than the
 * release carrying that signal leaves this extension unable to capture
 * anything, so it tints nothing at all rather than painting colours it would
 * then repaint over the user's next pick - and it says so, because a user whose
 * assistant tabs used to be coloured watches them go plain and the cause is one
 * upgrade away.
 *
 * "Once per page" is the part only a browser can answer. Every docked assistant
 * panel builds its own terminal manager against the same companion, so the
 * three panels this suite docks would print the same line three times without
 * the latch that suppresses it. The unit tier constructs one manager and cannot
 * see that.
 *
 * Which branch is expected is read from the installed companion rather than
 * assumed, and it is read from the same thing the extension itself narrows on -
 * the injected token. The companion's server route would have been the easier
 * probe and is the wrong one: an operator can disable the server extension
 * while the frontend API is fully present, and the test would then demand a
 * warning the extension is right not to print.
 */
test.use({ autoGoto: false, waitForApplication });

/** The companion plugin, whose provided service IS the injected token. */
const COMPANION_PLUGIN = 'jupyterlab_colourful_tab_extension:plugin';

const LOG_PREFIX = '[jupyterlab_ai_code_assistants_extension]';
/** Enough of the warning to identify it without pinning its wording. */
const LEGACY_WARNING = 'jupyterlab_colourful_tab_extension is older than';

test('the companion floor is stated once, and only when it is unmet', async ({
  page
}) => {
  const logs: string[] = [];
  page.on('console', message => {
    logs.push(message.text());
  });

  await page.goto();

  // The same two members `tabColourOwner` narrows on, read off the same object
  // the extension is handed.
  const owns = await page.evaluate(async (pluginId: string) => {
    const token = (await (window as any).galata.getPlugin(pluginId)) as any;
    return (
      typeof token?.claim === 'function' &&
      typeof token?.colourChanged?.connect === 'function'
    );
  }, COMPANION_PLUGIN);

  const stated = logs.filter(
    text => text.startsWith(LOG_PREFIX) && text.includes(LEGACY_WARNING)
  );

  expect(stated).toHaveLength(owns ? 0 : 1);
});
