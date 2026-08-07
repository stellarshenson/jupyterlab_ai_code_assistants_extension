import { expect, test } from '@jupyterlab/galata';

import {
  ABSENT,
  AVAILABLE,
  fetchStatus,
  panelId,
  setProviderEnabled,
  waitForApplication
} from './shared';

test.use({ autoGoto: false, waitForApplication });

const panels = (page: any) => page.locator('.jp-AiAssistantsPanel');
const panelFor = (page: any, providerId: string) =>
  page.locator(`.jp-AiAssistantsPanel[data-provider="${providerId}"]`);

test('the server roster matches the stubbed binaries', async ({ page }) => {
  await page.goto();

  const status = await fetchStatus(page);
  const available = status.providers
    .filter(p => p.available)
    .map(p => p.id)
    .sort();
  const unavailable = status.providers
    .filter(p => !p.available)
    .map(p => p.id)
    .sort();

  // If this fails, the server config and the specs have drifted apart - fix
  // them together rather than relaxing an assertion below.
  expect(available).toEqual([...AVAILABLE].sort());
  expect(unavailable).toEqual([...ABSENT].sort());
});

test('one panel per enabled provider whose binary is present', async ({
  page
}) => {
  await page.goto();

  await expect(panels(page)).toHaveCount(AVAILABLE.length);

  for (const id of AVAILABLE) {
    // Exactly one, not "at least one": a second panel for the same provider is
    // precisely what a leftover standalone extension would produce.
    await expect(panelFor(page, id)).toHaveCount(1);
    await expect(
      page.locator(`.lm-TabBar-tab[data-id="${panelId(id)}"]`)
    ).toHaveCount(1);
  }
});

test('each panel carries its own provider title', async ({ page }) => {
  await page.goto();

  const status = await fetchStatus(page);
  const titles: string[] = [];
  for (const id of AVAILABLE) {
    await page.sidebar.openTab(panelId(id));
    const label = status.providers.find(p => p.id === id)!.label;
    // `textContent`, not `innerText`: the header is styled uppercase, and
    // `innerText` returns the rendered casing rather than the descriptor's.
    const title =
      (await panelFor(page, id)
        .locator('.jp-AiAssistantsPanel-title')
        .textContent()) ?? '';
    // The panel title is the descriptor's own string, not a formula over the
    // label - Kimi's label is "Kimi" while its panel reads "Kimi Code
    // Sessions". What must hold is that it names its own assistant.
    expect(title).toContain(label);
    titles.push(title);
  }
  // Distinct titles, so two docked panels are never mistaken for each other.
  expect(new Set(titles).size).toBe(AVAILABLE.length);
});

test('a provider whose binary is absent renders no panel and no dialog', async ({
  page
}) => {
  await page.goto();

  for (const id of ABSENT) {
    await expect(panelFor(page, id)).toHaveCount(0);
    await expect(
      page.locator(`.lm-TabBar-tab[data-id="${panelId(id)}"]`)
    ).toHaveCount(0);
  }
  // A missing CLI is an ordinary state, not an error: the extension activates,
  // says so, and simply docks no panel for it.
  await expect(page.locator('.jp-Dialog')).toHaveCount(0);
});

test('disabling a provider removes its panel and leaves the others', async ({
  page
}) => {
  await page.goto();
  await expect(panels(page)).toHaveCount(AVAILABLE.length);

  const [target, ...others] = AVAILABLE;
  await setProviderEnabled(page, target, false);

  await expect(panelFor(page, target)).toHaveCount(0);
  await expect(panels(page)).toHaveCount(AVAILABLE.length - 1);
  for (const id of others) {
    await expect(panelFor(page, id)).toHaveCount(1);
  }
});

test('re-enabling a provider re-docks exactly one panel', async ({ page }) => {
  await page.goto();

  const [target] = AVAILABLE;
  await setProviderEnabled(page, target, false);
  await expect(panelFor(page, target)).toHaveCount(0);

  await setProviderEnabled(page, target, true);

  // One, not two: the reconcile must start the provider it stopped, not add a
  // second panel beside a stale one.
  await expect(panelFor(page, target)).toHaveCount(1);
  await expect(panels(page)).toHaveCount(AVAILABLE.length);
});
