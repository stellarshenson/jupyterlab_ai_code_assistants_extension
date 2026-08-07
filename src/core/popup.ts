import { Clipboard, Dialog } from '@jupyterlab/apputils';
import { copyIcon } from '@jupyterlab/ui-components';
import { Widget } from '@lumino/widgets';

import { branchIcon } from './icons';
import { IBranch } from './types';

/**
 * The Manage Sessions popup: a searchable, scrollable table over every
 * conversation of one project, with the current one pinned at the top,
 * checkbox multi-select and a two-step delete.
 *
 * Its own module because it is a screen, not a panel detail - the panel hands
 * it a branch list and four callbacks and never sees its DOM.
 */
export namespace ManageSessionsPopup {
  export interface IOptions {
    /** Conversations other than the current one. */
    branches: IBranch[];
    /** The project's current conversation id, pinned at the top. */
    current: string;
    /** Display name of the row this popup was opened from. */
    projectName: string;
    /** Whether deletions move to trash - the popup says which it means. */
    deleteToTrash: boolean;
    /** Display name for one branch, `<label> (<short id>)` by default. */
    branchName: (branch: IBranch) => string;
    /** Relative-time label for a branch. */
    formatTime: (epochMs: number) => string;
    /** Provider chip for a branch row, or null. */
    branchBadge?: (branch: IBranch) => HTMLElement | null;
    /** Make a conversation the row's current one. */
    onSwitch: (sessionId: string) => void;
    /** Open a conversation in its own terminal. */
    onOpen: (sessionId: string) => void;
    /** Delete conversations; resolves with the removed count, or null on a
     * failure the caller has already reported. */
    onDelete: (sessionIds: string[]) => Promise<number | null>;
    /** Re-read the branch list from the server. */
    onRefetch: () => Promise<IBranch[]>;
    /** Called with the fresh list whenever the popup re-syncs, so the panel's
     * own cached branch list does not drift from what is on screen. */
    onSync?: (branches: IBranch[]) => void;
  }
}

/** Compact copy button for a popup row. `stopPropagation` keeps the click from
 * switching or selecting the row it sits in. */
function copyButton(sessionId: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'jp-AiAssistantsPanel-branchCopy';
  btn.title = 'Copy session id';
  copyIcon.element({ container: btn });
  btn.addEventListener('click', e => {
    e.stopPropagation();
    Clipboard.copyToSystem(sessionId);
  });
  return btn;
}

export function showManageSessionsPopup(
  options: ManageSessionsPopup.IOptions
): void {
  // Local working copy so deletions can refresh the list in place.
  let items = [...options.branches];
  const selected = new Set<string>();
  let deleting = false; // guards the async delete against double invocation
  // Permanent deletion arms first and executes on the second click; a trashed
  // deletion is recoverable and goes straight through.
  const armsFirst = !options.deleteToTrash;
  let armed = false;
  let armTimer = 0;

  const body = document.createElement('div');
  body.className = 'jp-AiAssistantsPanel-branchPopup';

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Filter sessions...';
  search.setAttribute('aria-label', 'Filter sessions');
  search.className = 'jp-AiAssistantsPanel-branchSearch';
  body.appendChild(search);

  // Header strip: select-all left, conversation count right.
  const header = document.createElement('div');
  header.className = 'jp-AiAssistantsPanel-branchHeader';
  const selectAllBar = document.createElement('label');
  selectAllBar.className = 'jp-AiAssistantsPanel-branchSelectAll';
  const selectAll = document.createElement('input');
  selectAll.type = 'checkbox';
  selectAllBar.appendChild(selectAll);
  selectAllBar.appendChild(document.createTextNode('Select all'));
  header.appendChild(selectAllBar);
  const countEl = document.createElement('span');
  countEl.className = 'jp-AiAssistantsPanel-branchHeaderCount';
  header.appendChild(countEl);
  body.appendChild(header);

  const list = document.createElement('div');
  list.className = 'jp-AiAssistantsPanel-branchList';
  // role=group makes the aria-label apply to the conversation list region.
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Conversations');
  body.appendChild(list);

  const footer = document.createElement('div');
  footer.className = 'jp-AiAssistantsPanel-branchFooter';
  // Plain visual counter (selection, or the last action). The screen-reader
  // announcement lives in its own live region so per-checkbox ticks are not
  // announced on top of the native checkbox.
  const selCount = document.createElement('span');
  selCount.className = 'jp-AiAssistantsPanel-branchSelCount';
  footer.appendChild(selCount);
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'jp-AiAssistantsPanel-branchDelete';
  deleteBtn.title = options.deleteToTrash
    ? 'Deleted conversations move to the trash (recoverable)'
    : 'Deleted conversations are removed permanently';
  footer.appendChild(deleteBtn);
  body.appendChild(footer);

  // Visually hidden polite live region, announced only on delete.
  const srLive = document.createElement('div');
  srLive.className = 'jp-AiAssistantsPanel-srOnly';
  srLive.setAttribute('role', 'status');
  srLive.setAttribute('aria-live', 'polite');
  body.appendChild(srLive);

  const bodyWidget = new Widget({ node: body });
  const dialog = new Dialog({
    title: 'Manage Sessions',
    body: bodyWidget,
    buttons: [Dialog.cancelButton()]
  });

  // Per-row "Open" launches that conversation in its own terminal and closes
  // the popup. stopPropagation keeps the click from toggling selection or
  // switching the row.
  const openButton = (sessionId: string): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jp-AiAssistantsPanel-branchOpen';
    btn.textContent = 'Open';
    btn.title = 'Open this conversation in its own terminal';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      dialog.dispose();
      options.onOpen(sessionId);
    });
    return btn;
  };

  const visibleMatches = (): IBranch[] => {
    const needle = search.value.trim().toLowerCase();
    return items.filter(
      b =>
        !needle ||
        b.label.toLowerCase().includes(needle) ||
        b.session_id.toLowerCase().includes(needle)
    );
  };

  /** Drop the armed state - the count an armed button names must never outlive
   * the selection it was armed for. Callers refresh the button themselves. */
  const disarm = (): void => {
    armed = false;
    window.clearTimeout(armTimer);
  };

  const updateControls = (): void => {
    deleteBtn.disabled = deleting || selected.size === 0;
    deleteBtn.textContent = deleting
      ? 'Deleting...'
      : armed
        ? `Confirm delete ${selected.size}`
        : `Delete (${selected.size})`;
    deleteBtn.classList.toggle('jp-mod-armed', armed && !deleting);
    selCount.textContent = selected.size ? `${selected.size} selected` : '';
    selCount.classList.remove('jp-mod-deleted');
    const visible = visibleMatches();
    const total = items.length + 1; // + the pinned current conversation
    const shown = visible.length + 1; // the current row is always shown
    countEl.textContent = search.value.trim()
      ? `${shown} of ${total}`
      : `${total} conversation${total === 1 ? '' : 's'}`;
    const visibleSelected = visible.filter(b =>
      selected.has(b.session_id)
    ).length;
    selectAll.checked =
      visible.length > 0 && visibleSelected === visible.length;
    selectAll.indeterminate =
      visibleSelected > 0 && visibleSelected < visible.length;
  };

  const render = (): void => {
    list.replaceChildren();

    // The current conversation leads the list - badged, unselectable,
    // undeletable; only the extras below it are manageable.
    const currentRow = document.createElement('div');
    currentRow.className = 'jp-AiAssistantsPanel-branchRow jp-mod-current';
    currentRow.title = `Session id: ${options.current}`;
    // The brand left-bar, tint and plain "current" text are visual-only cues.
    currentRow.setAttribute('aria-current', 'true');
    // Empty select cell keeps the name column aligned with branch rows.
    const currentSelect = document.createElement('span');
    currentSelect.className = 'jp-AiAssistantsPanel-branchSelectCell';
    currentRow.appendChild(currentSelect);
    const currentLabel = document.createElement('span');
    currentLabel.className = 'jp-AiAssistantsPanel-branchLabel';
    // Text in its own ellipsising span so any chip survives truncation - the
    // same structure the branch rows below use.
    const currentText = document.createElement('span');
    currentText.className = 'jp-AiAssistantsPanel-branchLabelText';
    currentText.textContent = `${options.projectName} (${options.current.slice(
      0,
      8
    )})`;
    currentLabel.appendChild(currentText);
    currentRow.appendChild(currentLabel);
    const badge = document.createElement('span');
    badge.className = 'jp-AiAssistantsPanel-branchCurrentBadge';
    badge.textContent = 'current';
    currentRow.appendChild(badge);
    currentRow.appendChild(openButton(options.current));
    currentRow.appendChild(copyButton(options.current));
    list.appendChild(currentRow);

    const matches = visibleMatches();
    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'jp-AiAssistantsPanel-emptySection';
      empty.textContent = items.length
        ? 'No matching sessions.'
        : 'No other conversations.';
      list.appendChild(empty);
      return;
    }

    for (const b of matches) {
      const row = document.createElement('div');
      row.className = 'jp-AiAssistantsPanel-branchRow';
      row.title = `Session id: ${b.session_id}`;

      const selectCell = document.createElement('span');
      selectCell.className = 'jp-AiAssistantsPanel-branchSelectCell';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = selected.has(b.session_id);
      check.setAttribute('aria-label', `Select ${options.branchName(b)}`);
      // The checkbox is its own click zone - ticking must not switch.
      check.addEventListener('click', e => {
        e.stopPropagation();
        if (deleting) {
          // Keyboard Space is not blocked by the busy scrim's pointer-events;
          // re-sync the native toggle instead.
          check.checked = selected.has(b.session_id);
          return;
        }
        if (check.checked) {
          selected.add(b.session_id);
        } else {
          selected.delete(b.session_id);
        }
        disarm();
        updateControls();
      });
      selectCell.appendChild(check);
      // The whole cell is a select target (>=24px), not just the checkbox.
      selectCell.addEventListener('click', e => {
        if (e.target !== check) {
          e.stopPropagation();
          check.click();
        }
      });
      row.appendChild(selectCell);

      const label = document.createElement('span');
      label.className = 'jp-AiAssistantsPanel-branchLabel';
      // The text gets its own ellipsising span so the marker after it can
      // never be clipped away: branch labels are titles that routinely fill
      // the label column, and a marker inside the ellipsised span vanishes on
      // exactly those rows.
      const labelText = document.createElement('span');
      labelText.className = 'jp-AiAssistantsPanel-branchLabelText';
      labelText.textContent = options.branchName(b);
      label.appendChild(labelText);
      const providerBadge = options.branchBadge?.(b) ?? null;
      if (providerBadge) {
        label.appendChild(providerBadge);
      } else {
        const fork = document.createElement('span');
        fork.className = 'jp-AiAssistantsPanel-branchBadge';
        const icon = document.createElement('span');
        icon.className = 'jp-AiAssistantsPanel-branchBadgeIcon';
        branchIcon.element({ container: icon });
        fork.appendChild(icon);
        label.appendChild(fork);
      }
      row.appendChild(label);

      const time = document.createElement('span');
      time.className = 'jp-AiAssistantsPanel-branchTime';
      time.textContent = options.formatTime(b.file_mtime);
      row.appendChild(time);

      row.appendChild(openButton(b.session_id));
      row.appendChild(copyButton(b.session_id));

      const activate = (): void => {
        // Selection mode: while anything is ticked, row clicks toggle
        // selection - no accidental switch mid-selection.
        if (selected.size > 0) {
          if (selected.has(b.session_id)) {
            selected.delete(b.session_id);
          } else {
            selected.add(b.session_id);
          }
          check.checked = selected.has(b.session_id);
          disarm();
          updateControls();
          return;
        }
        dialog.dispose();
        options.onSwitch(b.session_id);
      };
      row.addEventListener('click', activate);
      // Switch has no button of its own, so it needs a role and a key route or
      // it is reachable by mouse only. The affordance sits on the label span,
      // not the row: the row also hosts a checkbox and the Open/Copy buttons,
      // and a role="button" wrapping them both swallows their own Enter/Space
      // and makes them presentational children (ARIA nested-interactive).
      label.setAttribute('role', 'button');
      label.tabIndex = 0;
      label.addEventListener('keydown', e => {
        // The busy scrim is pointer-events CSS and does not block keyboard.
        if (deleting) {
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          // Space would scroll the list otherwise.
          e.preventDefault();
          activate();
        }
      });
      list.appendChild(row);
    }
  };

  selectAll.addEventListener('change', () => {
    if (deleting) {
      return;
    }
    // Select-all acts on the visible (filtered) rows only.
    const visible = visibleMatches();
    if (selectAll.checked) {
      visible.forEach(b => selected.add(b.session_id));
    } else {
      visible.forEach(b => selected.delete(b.session_id));
    }
    disarm();
    render();
    updateControls();
  });

  // Busy-lock the whole body during the async delete, so a slow backend cannot
  // be double-clicked into deleting the same set twice and a mid-flight
  // selection cannot be silently discarded. The Dialog's Cancel button sits
  // outside the body and stays usable.
  const setDeleting = (on: boolean): void => {
    deleting = on;
    body.classList.toggle('jp-mod-busy', on);
    if (on) {
      list.setAttribute('aria-busy', 'true');
    } else {
      list.removeAttribute('aria-busy');
    }
  };

  deleteBtn.addEventListener('click', () => {
    if (deleting || selected.size === 0) {
      return;
    }
    // No confirmation DIALOG here: a second Lumino dialog stacked on this popup
    // renders detached. A permanent deletion still confirms, in the footer
    // itself - the first click arms the button, the second executes, and any
    // selection change or four seconds of hesitation disarms it. A trashed
    // deletion is recoverable, so it keeps going through on one click, with
    // the live "N deleted" status and a toast from the caller on failure.
    if (armsFirst && !armed) {
      armed = true;
      window.clearTimeout(armTimer);
      armTimer = window.setTimeout(() => {
        disarm();
        updateControls();
      }, 4000);
      updateControls();
      return;
    }
    disarm();
    setDeleting(true);
    updateControls();
    void options
      .onDelete([...selected])
      .then(async deleted => {
        if (deleted === null) {
          setDeleting(false);
          updateControls(); // re-enable; selection unchanged
          return;
        }
        // Re-sync from disk truth, not an optimistic splice: a conversation
        // the server skipped (it became the resolved-current, or was already
        // gone) must not vanish from the list while it still exists.
        try {
          items = await options.onRefetch();
        } catch {
          // Refetch failed (rare): optimistic removal. The announced count may
          // then differ from the rows removed; the panel's own poll reconciles.
          items = items.filter(b => !selected.has(b.session_id));
        }
        // The user may have closed the popup during the refetch await - do not
        // touch shared state or a detached DOM in that case.
        if (!bodyWidget.isAttached) {
          return;
        }
        setDeleting(false);
        selected.clear();
        options.onSync?.(items);
        render();
        updateControls();
        const moved = options.deleteToTrash
          ? `${deleted} moved to trash`
          : `${deleted} deleted`;
        selCount.textContent = moved;
        selCount.classList.add('jp-mod-deleted');
        // Clear then re-set on the next tick so an identical count (two single
        // deletes in a row) is still re-announced by aria-live.
        srLive.textContent = '';
        window.setTimeout(() => {
          srLive.textContent = moved;
        }, 60);
        // Keep focus inside the dialog - render() destroyed the focused row.
        // The select-all checkbox is a real control with a reliable keyboard
        // ring, unless the user is still typing in the search box.
        if (document.activeElement !== search) {
          selectAll.focus();
        }
      })
      .catch(() => {
        // Defensive: never leave the button stuck disabled.
        if (bodyWidget.isAttached) {
          setDeleting(false);
          updateControls();
        }
      });
  });

  search.addEventListener('input', () => {
    if (deleting) {
      return;
    }
    render();
    updateControls();
  });

  render();
  updateControls();

  // dialog.dispose() (on open/switch) rejects this promise with `undefined`;
  // catch it so the teardown never surfaces as an unhandled rejection.
  dialog.launch().catch(() => undefined);
  search.focus();
}
