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
let onDelete: jest.Mock;
// Each test opens a fresh popup in beforeEach; a describe that needs the
// permanent mode flips this in its beforeAll, which runs ahead of it.
let deleteToTrash = true;

function open(): void {
  showManageSessionsPopup({
    branches: [branch(FIRST, 'first'), branch(SECOND, 'second')],
    current: 'session-00000000-0000-4000-8000-000000000000',
    currentName: 'proj (00000000)',
    deleteToTrash,
    branchName: b => b.label,
    formatTime: () => 'now',
    openTitle: () => 'Open',
    onSwitch,
    onOpen: jest.fn(),
    onDelete,
    onRefetch: jest.fn(async () => [])
  });
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

beforeEach(() => {
  onSwitch = jest.fn();
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

  it('deletes without closing the dialog', async () => {
    checkbox(rows()[1]).click();
    deleteButton().click();
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
