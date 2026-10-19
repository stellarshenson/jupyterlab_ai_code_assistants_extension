/**
 * The Manage Sessions popup's click zones. A row click switches to that
 * conversation whatever is selected, and the checkbox cell is the only
 * control that selects - one meaning per click (DEF-PANE-209).
 */

jest.mock('@jupyter/react-components', () => ({}));
jest.mock('@jupyter/web-components', () => ({
  addJupyterLabThemeChangeListener: () => undefined,
  applyJupyterTheme: () => undefined,
  jpButton: () => undefined,
  jpToolbar: () => undefined,
  provideJupyterDesignSystem: () => ({ register: () => undefined })
}));

import { Dialog } from '@jupyterlab/apputils';

import { showManageSessionsPopup } from '../core/popup';
import { IBranch } from '../core/types';

const FIRST = 'session-11111111-1111-4111-8111-111111111111';
const SECOND = 'session-22222222-2222-4222-8222-222222222222';

function branch(sessionId: string, label: string): IBranch {
  return { session_id: sessionId, file_mtime: 1, label };
}

let onSwitch: jest.Mock;
let onOpen: jest.Mock;
let onDelete: jest.Mock;
// Each test opens a fresh popup in beforeEach; a describe that needs the
// permanent mode flips this in its beforeAll, which runs ahead of it.
let deleteToTrash = true;

function open(mode: 'switch' | 'open' = 'switch'): void {
  showManageSessionsPopup({
    mode,
    branches: [branch(FIRST, 'first'), branch(SECOND, 'second')],
    current: 'session-00000000-0000-4000-8000-000000000000',
    currentName: 'proj (00000000)',
    deleteToTrash,
    branchName: b => b.label,
    formatTime: () => 'now',
    openTitle: () => 'Open',
    onSwitch,
    onOpen,
    onDelete,
    onRefetch: jest.fn(async () => [])
  });
}

/** Replace the default switch-mode popup with one opened in `mode`, and let
 * the launch queue attach it before the test queries rows. */
async function reopen(mode: 'switch' | 'open'): Promise<void> {
  Dialog.flush();
  open(mode);
  await new Promise(resolve => setTimeout(resolve, 0));
}

function rows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.jp-AiAssistantsPanel-branchRow')
  );
}

function checkbox(row: HTMLElement): HTMLInputElement {
  return row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

function deleteButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    '.jp-AiAssistantsPanel-branchDelete'
  )!;
}

/** The per-row action button - Switch or Open, by popup mode. */
function actionButtons(row: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    row.querySelectorAll<HTMLButtonElement>('.jp-AiAssistantsPanel-branchOpen')
  );
}

beforeEach(() => {
  onSwitch = jest.fn();
  onOpen = jest.fn();
  onDelete = jest.fn(async () => 0);
  open();
});

// A dialog left open would hold the next one in the launch queue, so every
// test ends with the tracker emptied.
afterEach(() => {
  Dialog.flush();
});

describe('Manage Sessions popup click zones', () => {
  it('a row click switches even while another row is selected', () => {
    const [current, first, second] = rows();
    expect(current).toBeDefined();
    checkbox(first).click();
    expect(checkbox(first).checked).toBe(true);

    second.click();

    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith(SECOND);
    expect(document.querySelector('.jp-Dialog')).toBeNull();
  });

  it('the checkbox selects and never switches', () => {
    const [, first] = rows();
    checkbox(first).click();
    checkbox(first).click();

    expect(onSwitch).not.toHaveBeenCalled();
    expect(checkbox(first).checked).toBe(false);
    expect(document.querySelector('.jp-Dialog')).not.toBeNull();
  });
});

describe('Manage Sessions popup action mode (DEF-PANE-326)', () => {
  it('switch mode labels non-current rows Switch and calls onSwitch', () => {
    const [, first, second] = rows();
    const buttons = [...actionButtons(first), ...actionButtons(second)];
    expect(buttons.map(b => b.textContent)).toEqual(['Switch', 'Switch']);
    expect(buttons[0].title).toBe(
      "Make this the project's current conversation"
    );

    actionButtons(second)[0].click();

    expect(onSwitch).toHaveBeenCalledWith(SECOND);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('open mode labels non-current rows Open and calls onOpen', async () => {
    await reopen('open');
    const [, first, second] = rows();
    const buttons = [...actionButtons(first), ...actionButtons(second)];
    expect(buttons.map(b => b.textContent)).toEqual(['Open', 'Open']);
    expect(buttons[0].title).toBe('Open');

    actionButtons(second)[0].click();

    expect(onOpen).toHaveBeenCalledWith(SECOND);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('a row click switches in switch mode and opens in open mode', async () => {
    const [, first] = rows();
    first.click();

    expect(onSwitch).toHaveBeenCalledWith(FIRST);
    expect(onOpen).not.toHaveBeenCalled();

    await reopen('open');
    const [, openFirst] = rows();
    openFirst.click();

    expect(onOpen).toHaveBeenCalledWith(FIRST);
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it('the current row has no action in switch mode and Open in open mode', async () => {
    const [current] = rows();
    expect(actionButtons(current)).toHaveLength(0);

    await reopen('open');
    const [openCurrent] = rows();
    expect(actionButtons(openCurrent).map(b => b.textContent)).toEqual([
      'Open'
    ]);
  });
});

describe('Manage Sessions popup focus (DEF-PANE-314)', () => {
  // The popup moves the focus to the filter once the dialog is ready.
  const ready = (): Promise<void> => Dialog.tracker.find(() => true)!.ready;

  it('opens with the keyboard focus on the filter, not on Close', async () => {
    await ready();
    expect(document.activeElement).toBe(
      document.querySelector('.jp-AiAssistantsPanel-branchSearch')
    );
  });

  it('sends focus that leaves the dialog to Close, not to the filter', async () => {
    await ready();
    // Shift+Tab from the filter, the first focusable element, leaves the
    // dialog; the dialog returns that focus to its primary button.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const close = document.querySelector<HTMLButtonElement>(
      '.jp-Dialog-footer .jp-Dialog-button'
    )!;
    expect(close.textContent).toBe('Close');
    expect(document.activeElement).toBe(close);
    outside.remove();
  });
});

describe('Manage Sessions popup Delete button (DEF-PANE-307)', () => {
  it('sits in the dialog action row, after the list and before Close', () => {
    const del = deleteButton();
    const footer = document.querySelector('.jp-Dialog-footer')!;
    expect(footer.contains(del)).toBe(true);
    expect(document.querySelector('.jp-Dialog-body')!.contains(del)).toBe(
      false
    );
    // Document order is tab order: the list, then Delete, then Close.
    const list = document.querySelector('.jp-AiAssistantsPanel-branchList')!;
    const close = footer.querySelector<HTMLButtonElement>('.jp-Dialog-button')!;
    expect(close.textContent).toBe('Close');
    expect(
      list.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      del.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // The counter sits beside the button it reports on.
    expect(
      footer.querySelector('.jp-AiAssistantsPanel-branchSelCount')
    ).not.toBeNull();
  });

  it('is disabled with nothing selected and enabled once a row is', () => {
    expect(deleteButton().disabled).toBe(true);
    checkbox(rows()[1]).click();
    expect(deleteButton().disabled).toBe(false);
    expect(deleteButton().textContent).toBe('Delete (1)');
  });

  it('names the trash outcome without promising recoverability', () => {
    expect(deleteButton().title).toContain(
      'a refused move may remove them permanently or leave them in place'
    );
  });

  it('arms, then deletes without closing the dialog', async () => {
    checkbox(rows()[1]).click();
    const del = deleteButton();
    // The trash setting does not promise the system will accept the move, so
    // the first click arms rather than deletes.
    del.click();
    expect(onDelete).not.toHaveBeenCalled();
    expect(del.textContent).toBe('Confirm delete 1');

    del.click();
    await Promise.resolve();
    expect(onDelete).toHaveBeenCalledWith([FIRST]);
    expect(document.querySelector('.jp-Dialog')).not.toBeNull();
  });
});

describe('Manage Sessions popup permanent Delete', () => {
  beforeAll(() => {
    deleteToTrash = false;
  });
  afterAll(() => {
    deleteToTrash = true;
  });

  it('arms first, and leaving the button disarms it', () => {
    checkbox(rows()[1]).click();
    const del = deleteButton();
    del.focus();
    del.click();
    expect(onDelete).not.toHaveBeenCalled();
    expect(del.classList.contains('jp-mod-armed')).toBe(true);
    expect(del.textContent).toBe('Confirm delete 1');

    del.blur();

    expect(del.classList.contains('jp-mod-armed')).toBe(false);
    expect(del.textContent).toBe('Delete (1)');
    expect(onDelete).not.toHaveBeenCalled();
  });
});
