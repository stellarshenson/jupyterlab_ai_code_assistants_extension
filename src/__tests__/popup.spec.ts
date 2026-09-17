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

function open(): void {
  showManageSessionsPopup({
    branches: [branch(FIRST, 'first'), branch(SECOND, 'second')],
    current: 'session-00000000-0000-4000-8000-000000000000',
    currentName: 'proj (00000000)',
    deleteToTrash: true,
    branchName: b => b.label,
    formatTime: () => 'now',
    openTitle: () => 'Open',
    onSwitch,
    onOpen: jest.fn(),
    onDelete: jest.fn(async () => 0),
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

beforeEach(() => {
  onSwitch = jest.fn();
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
