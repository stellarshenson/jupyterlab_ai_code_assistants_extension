import { JupyterFrontEnd } from '@jupyterlab/application';
import {
  Clipboard,
  Dialog,
  InputDialog,
  Notification,
  showDialog
} from '@jupyterlab/apputils';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { ServerConnection } from '@jupyterlab/services';
import { ITerminalTracker } from '@jupyterlab/terminal';
import { IColourfulTabs } from 'jupyterlab_colourful_tab_extension';
import {
  LabIcon,
  MenuSvg,
  closeIcon,
  folderIcon,
  terminalIcon
} from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { UUID } from '@lumino/coreutils';
import { Message } from '@lumino/messaging';
import { Menu, Widget } from '@lumino/widgets';

import { ColourStore } from './colour';
import {
  addIcon,
  branchIcon,
  cleanupIcon,
  filterIcon,
  providerIcon,
  refreshIcon,
  removeIcon,
  shieldIcon,
  starFilledIcon,
  switchIcon
} from './icons';
import {
  DEFAULT_RECENT_LIMIT,
  MAX_RECENT_LIMIT,
  MIN_RECENT_LIMIT
} from './limits';
import {
  IResolvedLaunchMode,
  resolveLaunchMode,
  resolvedLaunchModeEntry
} from './modes';
import { showManageSessionsPopup } from './popup';
import { LOG_PREFIX } from './registry';
import {
  isRequestTimeout,
  isResponseStatus,
  requestProvider,
  withQuery
} from './request';
import { TerminalManager } from './terminals';
import {
  IBranch,
  IBranchesResponse,
  ICleanupResponse,
  IDeleteSessionsResponse,
  IFavouriteResponse,
  IForkResponse,
  ILaunchMode,
  ILaunchRequest,
  IProviderDescriptor,
  IProviderHooks,
  IRemoveResponse,
  ISession,
  ISessionsListResponse,
  ISwitchResponse
} from './types';

// Rows refresh on this cadence. It is also what refreshes whatever roster the
// server caches for the context menu, so raising it past the server's cache
// horizon leaves that snapshot stale at every menu open.
const POLL_INTERVAL_MS = 30_000;
/** How long the context menu waits for fresh branch and colour state before
 * opening on what it already has.
 *
 * A right-click that shows nothing for longer than this reads as a lost click,
 * and the retry costs more than the wait: a second click supersedes the first,
 * so the menu never opens at all and the budget starts again. Listing branches
 * can spawn the assistant's own CLI, measured at ~320 ms, so this is roughly
 * 2.5x the honest work - and a fetch that loses is kept for the next open
 * rather than thrown away, so losing costs one degraded menu, not the branch
 * submenus for good. */
const MENU_STATE_BUDGET_MS = 800;
/** Minimum visible spin on a manual refresh. `_fetch` is filesystem-fast, so
 * without a floor the spinner shows for a frame and the click reads as
 * "nothing happened". */
const REFRESH_SPIN_FLOOR_MS = 500;
// After a fork is requested, watch for its lazily-written store entry at this
// faster cadence (bounded) so a new branch surfaces in seconds.
const BRANCH_WATCH_INTERVAL_MS = 2_000;
const BRANCH_WATCH_MAX_ATTEMPTS = 90; // ~3 minutes
/** Conversations listed inline in a branch submenu before the popup takes over. */
const INLINE_BRANCH_LIMIT = 5;

type SectionKey = 'favourites' | 'recent' | 'all';

export type PresentationMode = 'name' | 'path';

export const DEFAULT_PRESENTATION_MODE: PresentationMode = 'name';

const SECTION_LABELS: Record<SectionKey, string> = {
  favourites: 'Favorites',
  recent: 'Recent',
  all: 'All'
};

const DEFAULT_EXPANDED: Record<SectionKey, boolean> = {
  favourites: true,
  recent: true,
  all: true
};

/** Widget id for one provider's panel - what the layout restorer keys on. */
export function panelWidgetId(providerId: string): string {
  return `jupyterlab-ai-code-assistants-${providerId}`;
}

/** Command id for one provider's action. Namespaced per provider, so two
 * panels never collide in a shared registry. */
export function commandId(providerId: string, action: string): string {
  return `ai-code-assistants:${providerId}:${action}`;
}

function loadExpanded(storageKey: string): Record<SectionKey, boolean> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return { ...DEFAULT_EXPANDED };
    }
    const parsed = JSON.parse(raw);
    const read = (key: SectionKey): boolean =>
      typeof parsed?.[key] === 'boolean' ? parsed[key] : DEFAULT_EXPANDED[key];
    return {
      favourites: read('favourites'),
      recent: read('recent'),
      all: read('all')
    };
  } catch (_err) {
    return { ...DEFAULT_EXPANDED };
  }
}

function saveExpanded(
  storageKey: string,
  state: Record<SectionKey, boolean>
): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch (_err) {
    // localStorage unavailable (private mode, quota) - ignore.
  }
}

/**
 * One assistant's sessions panel.
 *
 * Layout, filtering, polling, menus, the popup and the launch flow are shared
 * by every provider. Everything that differs enters through the descriptor's
 * capability flags or through the provider's hooks - this class never asks
 * which assistant it is rendering.
 */
export class AssistantSessionsPanel extends Widget {
  constructor(options: AssistantSessionsPanel.IOptions) {
    super();
    this._app = options.app;
    this._descriptor = options.descriptor;
    this._hooks = options.hooks ?? {};
    this._serverSettings = options.app.serviceManager.serverSettings;
    this.setRoot(options.rootDir, options.deleteToTrash !== false);
    this._fileBrowser = options.fileBrowser ?? null;
    this._expandedKey = `jupyterlab_ai_code_assistants_extension:${this._descriptor.id}:expanded`;
    this._expanded = loadExpanded(this._expandedKey);

    this._colours = new ColourStore(this._descriptor.id, this._serverSettings);
    this._terminals = new TerminalManager({
      app: options.app,
      descriptor: this._descriptor,
      colourStore: this._colours,
      terminalTracker: options.terminalTracker ?? null,
      colourfulTabs: options.colourfulTabs ?? null,
      serverSettings: this._serverSettings
    });

    this.id = panelWidgetId(this._descriptor.id);
    this.title.icon = providerIcon(
      this._descriptor.iconName,
      this._descriptor.iconSvg
    );
    this.title.caption = this._descriptor.panelTitle;
    this.addClass('jp-AiAssistantsPanel');
    this.node.dataset.provider = this._descriptor.id;

    this._buildShell();
    this._setupCommands();
    // Tinting runs from startup, not from the first time the panel is shown -
    // the widget is constructed at activation whether or not the user ever
    // opens the panel.
    this._terminals.startColourLoop();
    void this._colours.load();
  }

  get descriptor(): IProviderDescriptor {
    return this._descriptor;
  }

  dispose(): void {
    this._stopPolling();
    // Disabling a provider must leave its running terminals alive and only
    // drop the tint this panel applied.
    void this._terminals.clearColours();
    this._terminals.dispose();
    super.dispose();
  }

  refresh(): void {
    // The veil covers the whole panel, header included, so raising it on a
    // re-show scrims rows that are already on screen and blocks the filter and
    // the refresh button for the length of the floor below. Only a COLD load
    // has nothing to show; every other refresh spins the button alone and
    // leaves the list live.
    if (this._sessions === null) {
      this._setLoading(true);
    }
    this._setRefreshSpinning(true);
    // The floor is held under reduced motion too. What that preference asks us
    // not to draw is MOTION; the CSS already swaps the spin for a static dim,
    // and holding that dim is the only feedback an explicit Refresh gives -
    // without it the click produces a few-millisecond flicker on a 16px icon.
    const minSpin = new Promise<void>(resolve =>
      window.setTimeout(resolve, REFRESH_SPIN_FLOOR_MS)
    );
    Promise.all([
      this._fetch().catch(err => this._showError(err)),
      minSpin
    ]).finally(() => {
      this._setRefreshSpinning(false);
      this._setLoading(false);
    });
  }

  /** Label rows by name (the session name the assistant records) or by path. */
  setPresentationMode(mode: PresentationMode): void {
    if (this._presentationMode === mode) {
      return;
    }
    this._presentationMode = mode;
    this._render();
  }

  /** How many rows the Recent section displays. */
  setRecentLimit(n: number): void {
    const clamped = Math.max(
      MIN_RECENT_LIMIT,
      Math.min(MAX_RECENT_LIMIT, Math.floor(n))
    );
    if (this._recentLimit === clamped) {
      return;
    }
    this._recentLimit = clamped;
    this._render();
  }

  /** Current values of this provider's launch modes, read from settings. Each
   * key is an `ILaunchMode.id` in the assistant's own terminology. */
  setModes(modes: Record<string, boolean | string>): void {
    this._modes = { ...modes };
    // Menu labels are lazy and re-read this on every open; the button's title
    // is a written string, so it has to be rewritten here. The glyph needs no
    // such hook - it is always "+", whatever mode is armed (DEF-112).
    this._renameNewButton?.();
  }

  setColouredTabs(on: boolean): void {
    this._colouredTabs = on;
    this._terminals.setColouredTabs(on);
  }

  protected onAfterShow(_msg: Message): void {
    this.refresh();
    this._startPolling();
  }

  protected onBeforeHide(_msg: Message): void {
    this._stopPolling();
  }

  protected onCloseRequest(msg: Message): void {
    this._stopPolling();
    super.onCloseRequest(msg);
  }

  // ------------------------------------------------------------------ shell

  private _buildShell(): void {
    const root = this.node;
    root.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'jp-AiAssistantsPanel-header';

    const title = document.createElement('span');
    title.className = 'jp-AiAssistantsPanel-title';
    title.textContent = this._descriptor.panelTitle;
    header.appendChild(title);

    const newBtn = document.createElement('button');
    newBtn.className = 'jp-AiAssistantsPanel-iconButton';
    // The title is a static string - the folder is deliberately NOT named
    // (a path five levels deep makes a tooltip unreadable) and nor is the
    // provider (the panel's own tab says which assistant this is) - plus the
    // armed-mode suffix: with a mode in force the variants suppress themselves
    // and this button LAUNCHES on click instead of dropping a menu, so without
    // the suffix the one surface that starts an approval-free session is the
    // only one that never says so (DEF-36, DEF-113, DEF-114).
    // Disabled, not silent, while the server root is unknown (a panel docked
    // before the first status roster, DEF-132): a healthy-looking button that
    // does nothing on click cannot be diagnosed by the user. `setRoot` re-runs
    // this once the root lands, so the state is data-driven, not timed.
    const nameNewButton = (): void => {
      newBtn.disabled = !this._rootDir;
      newBtn.title = this._rootDir
        ? `New session in current folder${this._variantSuffix()}`
        : 'Waiting for the server root';
    };
    // Focus as well as hover, or the icon-only button's accessible name is the
    // generic one for everybody not using a mouse.
    newBtn.addEventListener('pointerenter', nameNewButton);
    newBtn.addEventListener('focus', nameNewButton);
    // Held so `setModes` can re-title it. The shell is built before settings
    // arrive, so the title written here can only ever say "no mode in force";
    // a user who never hovers or focuses the button would keep reading that
    // after turning an approval-free mode on (DEF-38).
    this._renameNewButton = nameNewButton;
    nameNewButton();
    // The glyph is always "+", whatever mode is armed (DEF-112): the shield
    // marks the menu ENTRIES that skip approval, while the button that offers
    // or launches stays neutral - an armed mode is still named in the title
    // above, so the launch never goes unnamed.
    addIcon.element({ container: newBtn });
    newBtn.addEventListener('click', () => {
      // With a mode in force the variant items suppress themselves, leaving a
      // dropdown with one entry - two clicks for its only outcome. Do it.
      if (this._visibleVariantCount() === 0) {
        void this._newSession();
        return;
      }
      // Drop the menu just below the button, left-aligned with it.
      const rect = newBtn.getBoundingClientRect();
      this._newSessionMenu.open(rect.left, rect.bottom);
    });
    header.appendChild(newBtn);

    const filterBtn = document.createElement('button');
    filterBtn.className = 'jp-AiAssistantsPanel-iconButton';
    filterBtn.title = 'Filter sessions';
    // The pressed state is drawn with a class, which says nothing to a screen
    // reader; the filter bar starts hidden, so this starts false.
    filterBtn.setAttribute('aria-pressed', 'false');
    filterIcon.element({ container: filterBtn });
    filterBtn.addEventListener('click', () => this._toggleFilterBar());
    header.appendChild(filterBtn);
    this._filterBtn = filterBtn;

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'jp-AiAssistantsPanel-iconButton';
    refreshBtn.title = 'Refresh';
    refreshIcon.element({ container: refreshBtn });
    refreshBtn.addEventListener('click', () => this.refresh());
    header.appendChild(refreshBtn);
    this._refreshBtn = refreshBtn;

    // Input and its clear button share a wrapper so the button can sit inside
    // the field's right edge. The wrapper carries the hidden toggle, so the
    // button never outlives the input it belongs to.
    const searchWrap = document.createElement('div');
    searchWrap.className = 'jp-AiAssistantsPanel-searchWrap';
    // Hidden by default; the filter button reveals it. The `hidden` attribute
    // toggles `display: none` via the user-agent stylesheet, so the wrapper's
    // `display: flex` must not override it (see base.css).
    searchWrap.hidden = true;

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'jp-AiAssistantsPanel-search';
    search.placeholder = 'Filter sessions...';
    search.setAttribute('aria-label', 'Filter sessions');
    search.spellcheck = false;
    search.addEventListener('input', () => {
      this._filter = search.value;
      this._syncSearchClear();
      this._render();
    });
    this._searchEl = search;

    const searchClear = document.createElement('button');
    searchClear.className = 'jp-AiAssistantsPanel-searchClear';
    searchClear.title = 'Clear filter';
    searchClear.hidden = true;
    closeIcon.element({ container: searchClear });
    searchClear.addEventListener('click', () => {
      this._filter = '';
      search.value = '';
      this._syncSearchClear();
      this._render();
      // Clearing is a step in filtering, not the end of it - keep the caret in
      // the field so the next query can be typed straight away.
      search.focus();
    });
    this._searchClearEl = searchClear;

    searchWrap.appendChild(search);
    searchWrap.appendChild(searchClear);
    this._searchWrapEl = searchWrap;

    const body = document.createElement('div');
    body.className = 'jp-AiAssistantsPanel-body';

    // Refresh veil, shown only during an explicit refresh. It lives on the
    // root (not the body) so `_render` - which wipes the body - never removes
    // it.
    const loading = document.createElement('div');
    loading.className = 'jp-AiAssistantsPanel-loading';
    loading.hidden = true;
    const loadingSpinner = document.createElement('div');
    loadingSpinner.className =
      'jp-aiAssistants-spinner jp-AiAssistantsPanel-loadingSpinner';
    loading.appendChild(loadingSpinner);

    // Inline error strip - a failed poll reports here and keeps retrying,
    // rather than tearing the panel down or raising a modal that would also
    // interrupt the other providers' panels.
    const error = document.createElement('div');
    error.className = 'jp-AiAssistantsPanel-error';
    // Announced politely, so a failure a sighted user reads in red is not
    // silent for a screen-reader user.
    error.setAttribute('role', 'status');
    error.hidden = true;

    root.appendChild(header);
    root.appendChild(searchWrap);
    root.appendChild(error);
    root.appendChild(body);
    root.appendChild(loading);

    this._bodyEl = body;
    this._loadingEl = loading;
    this._errorEl = error;
  }

  /** Show / hide the filter input. Hiding also clears the active filter, so
   * the user never returns to an "invisible" filter narrowing the rows. */
  private _toggleFilterBar(): void {
    if (!this._searchEl || !this._searchWrapEl) {
      return;
    }
    const show = this._searchWrapEl.hidden;
    this._searchWrapEl.hidden = !show;
    if (this._filterBtn) {
      this._filterBtn.classList.toggle('jp-mod-active', show);
      this._filterBtn.setAttribute('aria-pressed', String(show));
    }
    if (show) {
      this._searchEl.focus();
    } else if (this._filter) {
      this._filter = '';
      this._searchEl.value = '';
      this._syncSearchClear();
      this._render();
    }
  }

  /** Show the clear button only while the field has text - an "x" over an
   * empty box is noise, and there is nothing to clear. */
  private _syncSearchClear(): void {
    if (this._searchClearEl) {
      this._searchClearEl.hidden = !this._searchEl?.value;
    }
  }

  /** Normalise for filter comparison: NFD-decompose, strip combining marks,
   * lowercase, and collapse separators entirely - so "foo-bar", "foo_bar",
   * "foo bar" and "Foo Bar" all compare equal as "foobar". */
  private _normalize(s: string): string {
    return s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[\s\-_./]+/g, '');
  }

  /** Fuzzy match at a 95% threshold: substring on normalised strings, with up
   * to 5% Levenshtein tolerance. For short queries the budget rounds to zero,
   * so behaviour is substring-only there; the relaxation only reaches a full
   * edit at 10+ characters. */
  private _fuzzyMatch(haystack: string, needle: string): boolean {
    if (!needle) {
      return true;
    }
    const h = this._normalize(haystack);
    const n = this._normalize(needle);
    if (!n) {
      return true;
    }
    if (h.includes(n)) {
      return true;
    }
    const tol = Math.round(n.length * 0.05);
    if (tol === 0) {
      return false;
    }
    for (let len = n.length - tol; len <= n.length + tol; len += 1) {
      if (len <= 0) {
        continue;
      }
      for (let i = 0; i + len <= h.length; i += 1) {
        if (this._levenshtein(h.slice(i, i + len), n) <= tol) {
          return true;
        }
      }
    }
    return false;
  }

  private _levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) {
      return n;
    }
    if (n === 0) {
      return m;
    }
    const dp: number[] = new Array(n + 1);
    for (let j = 0; j <= n; j += 1) {
      dp[j] = j;
    }
    for (let i = 1; i <= m; i += 1) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j += 1) {
        const tmp = dp[j];
        dp[j] =
          a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
        prev = tmp;
      }
    }
    return dp[n];
  }

  private _matchesFilter(s: ISession): boolean {
    const q = this._filter.trim();
    if (!q) {
      return true;
    }
    return (
      this._fuzzyMatch(s.name, q) ||
      this._fuzzyMatch(s.project_path, q) ||
      this._fuzzyMatch(this._lookupName(s), q)
    );
  }

  /** Raise or clear the full-panel refresh veil. Only the explicit refresh
   * path calls this; the background poll fetches silently so the panel never
   * flashes a spinner on its own. */
  private _setLoading(on: boolean): void {
    if (this._loadingEl) {
      this._loadingEl.hidden = !on;
    }
  }

  /** Inline, per-panel error. One provider's unreachable server must leave the
   * other panels alone, so nothing here is modal. */
  private _setInlineError(message: string | null): void {
    if (!this._errorEl) {
      return;
    }
    this._errorEl.textContent = message ?? '';
    this._errorEl.hidden = !message;
  }

  /** A polled or refreshed fetch failed. Only these two paths own a retry, so
   * only they may promise one. DEF-81: a client-side timeout means the server
   * was REACHED and did not answer in time, which is a different thing to
   * report than a server that is gone. */
  private _showError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this._logError(message);

    // DEF-138: the server ANSWERED, and its answer is that this assistant's
    // binary is not on the PATH the Jupyter server runs with. Blaming the
    // server names the wrong cause - the panel is docked only because no
    // roster has arrived yet, and the roster is what removes it (DEF-132).
    // The error code is matched as well as the status, because a 503 raised
    // by a proxy or a stopped single-user server is NOT this: its body never
    // parses to `{"error": "cli_not_found"}`, so it keeps the copy below.
    if (isResponseStatus(err, 503) && message === 'cli_not_found') {
      this._setInlineError(
        `\`${this._descriptor.cliBinary}\` was not found on the Jupyter ` +
          `server's PATH.`
      );
      return;
    }

    const copy = isRequestTimeout(err)
      ? 'The server is not answering - retrying.'
      : 'Could not reach the server - retrying.';
    this._setInlineError(`${copy} ${message}`);
  }

  /** A one-shot action failed. Nothing retries it, so the copy names what did
   * not happen instead of promising a retry the poll loop alone performs. */
  private _showActionError(copy: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this._logError(message);
    this._setInlineError(`${copy} ${message}`);
  }

  /** A launch failed. This cannot go to the inline banner: every launch path
   * refetches in its `finally`, and a successful `_fetch` clears the banner -
   * so the message would be painted and wiped within the same tick, leaving
   * the user with a flash. The banner's copy is wrong for this case anyway:
   * the launch REACHED the server and was refused, and nothing retries it. */
  private _notifyLaunchError(copy: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this._logError(message);
    Notification.error(`${copy}: ${message}`, { autoClose: 4000 });
  }

  private _logError(message: string): void {
    console.error(`${LOG_PREFIX}[${this._descriptor.id}]`, message);
  }

  // ------------------------------------------------------------------- data

  private async _fetch(): Promise<void> {
    // `cache: 'no-store'` so a manual refresh always re-reads the server's
    // view rather than a possibly stale browser-cached response.
    const data = await requestProvider<ISessionsListResponse>(
      this._descriptor.id,
      'sessions',
      this._serverSettings,
      { cache: 'no-store' }
    );
    this._sessions = data.sessions ?? [];
    this._setInlineError(null);
    this._terminals.setSessions(this._sessions);
    this._render();
    // Best-effort tinting; never let a colour failure break the fetch.
    void this._colours.load().then(() => this._terminals.reconcileColours());
  }

  private async _toggleFavourite(session: ISession): Promise<void> {
    const next = !session.favourite;
    session.favourite = next; // optimistic
    this._render();
    try {
      await requestProvider<IFavouriteResponse>(
        this._descriptor.id,
        'favourite',
        this._serverSettings,
        {
          method: 'POST',
          body: JSON.stringify({
            project_path: session.project_path,
            favourite: next
          })
        }
      );
    } catch (err) {
      session.favourite = !next; // roll back
      this._render();
      this._showActionError('Could not toggle favorite - try again.', err);
    }
  }

  private get _disposalVerb(): string {
    return this._deleteToTrash ? 'moved to trash' : 'deleted permanently';
  }

  private async _removeProject(session: ISession): Promise<void> {
    const name = this._lookupName(session);
    const confirm = await showDialog({
      title: `Remove from ${this._descriptor.label}`,
      body:
        `Remove "${name}" from ${this._descriptor.label}? This drops the ` +
        `entire project history and every conversation it holds - ` +
        `${this._disposalVerb}. This cannot be undone.`,
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Remove' })],
      // Cancel, explicitly. JupyterLab defaults `defaultButton` to the LAST
      // button and focuses it on attach, so omitting this handed the keyboard
      // to Remove - one Enter on a dialog that has just appeared and the
      // project history is gone (DEF-51). JupyterLab's own file browser sets
      // the same 0 on its delete, for the same reason.
      defaultButton: 0
    });
    if (!confirm.button.accept) {
      return;
    }

    this._removingPaths.add(session.encoded_path);
    this._render();
    try {
      await requestProvider<IRemoveResponse>(
        this._descriptor.id,
        'sessions',
        this._serverSettings,
        {
          method: 'DELETE',
          body: JSON.stringify({ encoded_path: session.encoded_path })
        }
      );
      // Drop locally; the next poll reconciles against disk.
      this._sessions = (this._sessions ?? []).filter(
        s => s.encoded_path !== session.encoded_path
      );
    } catch (err) {
      this._showActionError(`Could not remove "${name}" - try again.`, err);
    } finally {
      this._removingPaths.delete(session.encoded_path);
      this._render();
    }
  }

  private async _cleanupParallel(session: ISession): Promise<void> {
    const extra = session.extra_sessions;
    const name = this._lookupName(session);
    const confirm = await showDialog({
      title: 'Clean Up Parallel Sessions',
      body:
        `Remove ${extra} parallel session${extra === 1 ? '' : 's'} from ` +
        `"${name}"? The current conversation is kept; the rest are ` +
        `${this._disposalVerb}. This cannot be undone.`,
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Remove' })],
      // Cancel, as above (DEF-51).
      defaultButton: 0
    });
    if (!confirm.button.accept) {
      return;
    }

    const body = new Widget();
    body.node.className = 'jp-AiAssistantsPanel-cleanupBody';

    const message = document.createElement('div');
    message.className = 'jp-AiAssistantsPanel-cleanupMessage';
    message.textContent = `Removing ${extra} parallel session${
      extra === 1 ? '' : 's'
    }...`;
    body.node.appendChild(message);

    // No `value` attribute -> indeterminate (animated) while the request is in
    // flight; set to max on completion so the bar reads as finished.
    const bar = document.createElement('progress');
    bar.className = 'jp-AiAssistantsPanel-cleanupProgress';
    bar.max = 1;
    body.node.appendChild(bar);

    const dialog = new Dialog<unknown>({
      title: 'Clean Up Parallel Sessions',
      body,
      buttons: [Dialog.okButton({ label: 'Close' })]
    });
    // Close stays live while the work runs. Hiding it took away the only exit
    // a keyboard user has: the dialog listens for Escape on its own node, it
    // puts focus on this button and nowhere else, and focusing a hidden button
    // is a no-op - so Escape never reached the dialog and the sole way out was
    // a click on the backdrop. Closing early cancels nothing (the request runs
    // on to its own 60s ceiling), and a modal that cannot be left is worse than
    // one dismissed before its outcome is read.
    void dialog.launch();

    try {
      // The extras ARE the branch list - the current conversation is not in
      // it - so cleaning up is deleting exactly those ids.
      const listed = await this._fetchBranches(session);
      const ids = listed.branches.map(b => b.session_id);
      if (ids.length === 0) {
        // The menu item is gated on a row up to one poll old, so by the time
        // the refetch lands another tab may have cleaned the project already.
        // Every store REFUSES an empty id list, so sending it turned "nothing
        // to do" into `remove_failed` under a dialog that had just promised
        // to remove N.
        bar.remove();
        message.textContent = 'Nothing left to clean up.';
        this._branchCache = null;
        await this._fetch();
        return;
      }
      const data = await requestProvider<ICleanupResponse>(
        this._descriptor.id,
        'sessions',
        this._serverSettings,
        {
          method: 'DELETE',
          body: JSON.stringify({
            encoded_path: session.encoded_path,
            session_ids: ids
          })
        }
      );
      // Only the conversations that ACTUALLY went lose their colour - one the
      // server could not delete keeps its tint.
      await this._colours.forget(data.removed_ids ?? ids);
      // The kept listing names conversations that may have just gone.
      this._branchCache = null;
      bar.value = 1;
      message.textContent = `Removed ${data.removed_count} parallel session${
        data.removed_count === 1 ? '' : 's'
      }.`;
      // Refresh so the row's conversation count and menu label update.
      await this._fetch();
    } catch (err) {
      bar.remove();
      message.classList.add('jp-AiAssistantsPanel-cleanupError');
      message.textContent = `Cleanup failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  // ---------------------------------------------------------------- launch

  /** This provider's launch-mode token for one action - see
   * `resolveLaunchMode` for the precedence rule. */
  private _launchMode(force?: string): string | undefined {
    return resolveLaunchMode(this._descriptor.launchModes, this._modes, force);
  }

  private async _openSession(
    session: ISession,
    force?: string,
    sessionId?: string
  ): Promise<void> {
    try {
      await this._terminals.openSession(
        session,
        this._launchMode(force),
        sessionId
      );
    } catch (err) {
      if (isResponseStatus(err, 404)) {
        Notification.error(
          'That conversation no longer exists - the list has been refreshed.',
          { autoClose: 4000 }
        );
      } else {
        this._notifyLaunchError('Could not open that conversation', err);
      }
    } finally {
      // Reuse or fresh launch, either way the picture changed. Pull fresh
      // state; a poll tick retries if this one fails.
      void this._fetch().catch(() => undefined);
    }
  }

  /** The server root every path is shown and resolved against, plus
   * JupyterLab's move-to-trash setting. Settable because a panel docked before
   * the server has answered its first status probe is built without either
   * (DEF-132); the action paths read them lazily, so a late value applies on
   * the next click, and a root arriving after rows were drawn redraws them
   * once (DEF-136).
   *
   * Trailing slashes go, but never the root itself: serving JupyterLab at
   * `/` used to normalise to the empty string, which reads as "no root" -
   * the + button then did nothing at all, and Open Terminal and Show in File
   * Browser answered "outside the JupyterLab root" for every row inside it. */
  setRoot(rootDir: string, deleteToTrash: boolean): void {
    const root = (rootDir || '').replace(/\/+$/, '');
    const next = root || (rootDir ? '/' : '');
    const changed = next !== this._rootDir;
    this._rootDir = next;
    this._deleteToTrash = deleteToTrash;
    this._renameNewButton?.();
    // Guarded on the VALUE, not on the call: `reconcile` re-sends the same
    // root every status tick, so a changed-guard redraws exactly once, on the
    // '' -> root transition. `_sessions` stands in for "the shell is built and
    // rows are on screen" - it is null until the first `_fetch` answers, which
    // is what keeps the constructor's own `setRoot` from reaching `_render`
    // before `_buildShell` has created `_bodyEl`.
    if (changed && this._sessions !== null) {
      this._render();
    }
  }

  /** Absolute path of the file browser's current folder; the server root when
   * no file browser is available. */
  private _currentFolder(): string {
    // No roster yet (DEF-132): a relative folder joined to an empty root
    // would be an absolute path at the filesystem root.
    if (!this._rootDir) {
      return '';
    }
    const rel = (this._fileBrowser?.model?.path ?? '').replace(/^\/+/, '');
    if (!rel) {
      return this._rootDir;
    }
    return this._rootDir === '/' ? `/${rel}` : `${this._rootDir}/${rel}`;
  }

  /** Start a brand-new conversation in the file browser's current folder. */
  private async _newSession(force?: string): Promise<void> {
    const projectPath = this._currentFolder();
    if (!projectPath) {
      return;
    }
    // Mint the id here when the assistant accepts one, so the terminal is
    // identifiable from its argv and a later click refocuses this exact
    // conversation instead of guessing from an unknown terminal.
    const newId = this._descriptor.mintsNewSessionId ? UUID.uuid4() : undefined;
    // A project that already has a row may carry a branch pin; sending its
    // store key lets the server clear that pin so the new conversation is not
    // shadowed by a stale one (DEF-9).
    const existing = (this._sessions ?? []).find(
      s => s.project_path === projectPath
    );
    try {
      await this._terminals.launch(
        {
          project_path: projectPath,
          encoded_path: existing?.encoded_path,
          new_session_id: newId,
          mode: this._launchMode(force)
        },
        newId
      );
    } catch (err) {
      // Same shape as `_openSession` above - the `finally` refetches, so an
      // inline banner would not survive to be read.
      this._notifyLaunchError('Could not start a new session', err);
    } finally {
      void this._fetch().catch(() => undefined);
    }
  }

  /**
   * Branch the active row's current conversation, by the descriptor's
   * `forkStrategy`.
   *
   * The three strategies differ only in who mints the new id and when it
   * becomes knowable - so the shared part (ask for a name, launch a terminal
   * on the fork, inherit the parent's tint, surface the branch) lives here
   * once, and the strategy decides the payload and the discovery.
   */
  private async _branchSession(force?: string): Promise<void> {
    const session = this._activeSession;
    if (!session) {
      return;
    }
    const parentColour = this._terminals.colourFor(session);

    let name: string | undefined;
    if (this._descriptor.promptsForBranchName) {
      const named = await InputDialog.getText({
        title: 'Branch Session',
        label: 'Name for the new session',
        placeholder: this._lookupName(session)
      });
      if (!named.button.accept) {
        return;
      }
      name = (named.value ?? '').trim();
      if (!name) {
        // Reported, not swallowed. The placeholder shows the parent's name,
        // which reads as the "press Ok for the default" idiom, so Ok on an
        // empty field was a closed dialog with no POST and no word (DEF-43).
        // A notification rather than a disabled Ok because that is how this
        // panel refuses everywhere else - Open Terminal and Show in File
        // Browser on a folder outside the root - and `InputDialog.getText`
        // offers no hook to disable Ok while the field is empty; getting one
        // means replacing the dialog with a hand-built body widget.
        Notification.warning(
          'Enter a name for the new session - nothing was branched.',
          { autoClose: 4000 }
        );
        return;
      }
    }

    if (this._descriptor.forkStrategy === 'server-copy') {
      await this._branchByServerCopy(session, name, force);
      return;
    }
    if (this._descriptor.forkStrategy === 'native-command') {
      await this._branchByNativeCommand(session, force, parentColour);
      return;
    }
    await this._branchByNativeFlag(session, name, force, parentColour);
  }

  /** The CLI forks from a flag pair and takes the new id from us, so the fork
   * is known before it exists. Its store entry is written lazily, on the first
   * turn, so the branch is watched for rather than expected at once. */
  private async _branchByNativeFlag(
    session: ISession,
    name: string | undefined,
    force: string | undefined,
    parentColour: string | null
  ): Promise<void> {
    const forkId = UUID.uuid4();
    const request: ILaunchRequest = {
      project_path: session.project_path,
      // Arms the server's fork pin - without it the fork never becomes the
      // row's current conversation and recency drags the row back (DEF-9).
      encoded_path: session.encoded_path,
      session_id: session.session_id,
      fork_session_id: forkId,
      name,
      mode: this._launchMode(force)
    };
    try {
      await this._terminals.launch(request, forkId);
    } catch (err) {
      this._showActionError('Could not branch this session - try again.', err);
      return;
    }
    await this._inheritColour(parentColour, forkId, session.session_id);
    this._watchForBranch(session.encoded_path, forkId);
  }

  /** The CLI owns both the fork verb and the id, so the id has to be
   * discovered: snapshot the branch ids first, then diff after launch. */
  private async _branchByNativeCommand(
    session: ISession,
    force: string | undefined,
    parentColour: string | null
  ): Promise<void> {
    const known = new Set(
      (await this._fetchBranches(session).catch(() => null))?.branches.map(
        b => b.session_id
      ) ?? []
    );
    known.add(session.session_id);
    try {
      await this._terminals.launch({
        project_path: session.project_path,
        fork_from: session.session_id,
        mode: this._launchMode(force)
      });
    } catch (err) {
      this._showActionError('Could not branch this session - try again.', err);
      return;
    }
    this._watchForNewBranch(session, known, parentColour);
    void this._fetch().catch(() => undefined);
  }

  /** The assistant has no fork at all: the server copies the store entry and
   * answers with the new id, so the branch exists before the terminal opens
   * and one refresh surfaces it - no watcher needed. */
  private async _branchByServerCopy(
    session: ISession,
    name: string | undefined,
    force: string | undefined
  ): Promise<void> {
    // Let the parent's colour settle before the server reads it (DEF-74). The
    // server copies the store entry while minting the fork, so a colour picked
    // on the parent's tab moments earlier - still queued in this store's
    // request chain, unsent - is not in the server's store yet and the branch
    // is born wearing the PREVIOUS tint. Same gate as `_inheritColour`
    // (DEF-31): a reload is a queued request like every other of this store's
    // (DEF-30), so it is not sent until the capture ahead of it has been
    // answered, and awaiting it is what makes the server's read fresh. Only
    // inside the capture window, so an ordinary fork still costs no request.
    if (this._colours.isPending(session.session_id)) {
      await this._colours.load();
    }
    try {
      const fork = await requestProvider<IForkResponse>(
        this._descriptor.id,
        'branch',
        this._serverSettings,
        {
          method: 'POST',
          body: JSON.stringify({
            encoded_path: session.encoded_path,
            session_id: session.session_id,
            name
          })
        }
      );
      // No colour write here. `BranchHandler` already inherited it while
      // minting this fork, from a read taken server-side at request time -
      // strictly fresher than the click-time read this would repeat, and the
      // frontend's value simply overwrote it on every server-copy fork.
      this._branchCache = null;
      await this._terminals.launch(
        {
          project_path: session.project_path,
          session_id: fork.session_id,
          mode: this._launchMode(force)
        },
        fork.session_id
      );
    } catch (err) {
      if (isResponseStatus(err, 400)) {
        Notification.error(
          `${this._descriptor.label} cannot branch this conversation.`,
          { autoClose: 4000 }
        );
      } else {
        this._showActionError(
          'Could not branch this session - try again.',
          err
        );
      }
      return;
    }
    await this._fetch().catch(() => undefined);
  }

  /** Drop the hand-set colours of this project's conversations and re-tint
   * from the defaults at once, so nothing keeps showing a released colour
   * until the next reconcile tick. One request for the whole set, so a release
   * is never left half applied.
   *
   * The colourful-tab extension's own menu record is normally consumed when
   * the colour is captured, so this is the release. A tab closed in the window
   * between the capture write and the paint keeps that record, and reopening
   * the terminal re-captures the colour - rare, and visible rather than
   * silent, since the tab still wears it. */
  private async _resetColours(sessionIds: string[]): Promise<void> {
    if (!(await this._colours.forget(sessionIds))) {
      // No refresh afterwards: `_fetch` clears the inline error, and a failure
      // the user never sees reads as a reset that silently did nothing.
      this._setInlineError(
        sessionIds.length > 1
          ? 'Could not reset the tab colours - try again.'
          : 'Could not reset the tab colour - try again.'
      );
      return;
    }
    await this._terminals.reconcileColours();
    await this._fetch().catch(() => undefined);
  }

  /** Copy the parent's tint onto a fresh branch.
   *
   * A native-colour assistant hands every conversation its own colour, so a
   * fork already arrives correctly tinted: only what this extension's own
   * store holds for the parent is inherited there - an entry the parent itself
   * inherited counts, which is what makes a branch of a branch take what its
   * parent actually shows. Copying the parent's native tint instead would pin
   * the fork to it and shadow the fork's own `/color` for good.
   * Every other assistant inherits the parent's effective colour, which is the
   * only tint it has. */
  private async _inheritColour(
    parentColour: string | null,
    childId: string,
    parentId: string
  ): Promise<void> {
    // The project gained a conversation, so a listing kept from before it is
    // short by one.
    this._branchCache = null;
    // Let the parent's colour settle before copying it (DEF-31). The store
    // holds only server-confirmed values, so a colour picked on the parent's
    // tab moments earlier is not in it yet, and a fork started in that window
    // was born wearing the PREVIOUS tint - stored as inherited, so never
    // offered for release and corrected by no later pass.
    //
    // A reload is a queued request like every other of this store's (DEF-30):
    // it is not sent until the capture ahead of it has been answered, which is
    // what makes the re-read below current. It runs only inside the capture
    // window, so an ordinary fork still costs no request, and the wait is
    // bounded - every request is capped at REQUEST_TIMEOUT_MS (DEF-72). A
    // reload that fails keeps the cache, which by then holds whatever the
    // capture confirmed, so the re-read is current either way.
    if (this._colours.isPending(parentId)) {
      await this._colours.load();
    }
    // Re-read rather than trust `parentColour`, which was taken at click time -
    // before the name dialog. A capture in flight at click time may well have
    // landed while that dialog was open, which leaves nothing pending and the
    // snapshot stale all the same. It stays as the fallback everywhere but a
    // `native` provider - it is the only value here in which the derived hash
    // is resolved, so a parent this store holds no colour for still hands its
    // fork the tint it actually shows. `native` takes no fallback at all, for
    // the reason above.
    const stored = this._colours.get(parentId);
    const inherited =
      this._descriptor.colourSource === 'native'
        ? stored
        : (stored ?? parentColour);
    await this._colours.inherit(inherited, childId);
  }

  /** Poll fast for a fork whose id we already know, then refresh once. The
   * panel is never updated before the branch genuinely exists - it cannot list
   * a store entry that has not been written. */
  private _watchForBranch(encodedPath: string, forkId: string): void {
    let attempts = 0;
    const tick = async (): Promise<void> => {
      // dispose() can land between an await and this callback; the widget must
      // not keep polling off a dead object.
      if (this.isDisposed) {
        return;
      }
      attempts += 1;
      try {
        const data = await requestProvider<IBranchesResponse>(
          this._descriptor.id,
          withQuery('branches', { encoded_path: encodedPath }),
          this._serverSettings,
          { cache: 'no-store' }
        );
        if (
          data.current === forkId ||
          data.branches.some(b => b.session_id === forkId)
        ) {
          await this._fetch();
          return;
        }
      } catch {
        // Transient - keep watching until the attempt budget runs out.
      }
      if (attempts < BRANCH_WATCH_MAX_ATTEMPTS) {
        window.setTimeout(() => void tick(), BRANCH_WATCH_INTERVAL_MS);
      }
    };
    window.setTimeout(() => void tick(), BRANCH_WATCH_INTERVAL_MS);
  }

  /** Poll fast for a fork whose id the CLI minted: whichever conversation the
   * snapshot did not hold is the fork. It is then pinned as current (recency
   * alone would not - the actively written parent overtakes it) and inherits
   * the parent's tint. */
  private _watchForNewBranch(
    session: ISession,
    known: Set<string>,
    parentColour: string | null
  ): void {
    let attempts = 0;
    const tick = async (): Promise<void> => {
      if (this.isDisposed) {
        return;
      }
      attempts += 1;
      try {
        const data = await this._fetchBranches(session);
        const fresh = data.branches.find(b => !known.has(b.session_id));
        if (fresh) {
          await this._inheritColour(
            parentColour,
            fresh.session_id,
            session.session_id
          );
          await this._switchBranch(session, fresh.session_id);
          return;
        }
      } catch {
        // Transient - keep watching.
      }
      if (attempts < BRANCH_WATCH_MAX_ATTEMPTS) {
        window.setTimeout(() => void tick(), BRANCH_WATCH_INTERVAL_MS);
      }
    };
    window.setTimeout(() => void tick(), BRANCH_WATCH_INTERVAL_MS);
  }

  /** Make another conversation the row's current one. */
  private async _switchBranch(
    session: ISession,
    sessionId: string
  ): Promise<void> {
    try {
      const result = await requestProvider<ISwitchResponse>(
        this._descriptor.id,
        'switch',
        this._serverSettings,
        {
          method: 'POST',
          body: JSON.stringify({
            encoded_path: session.encoded_path,
            session_id: sessionId
          })
        }
      );
      if (result.current !== result.requested) {
        Notification.warning(
          'That conversation could not be made the current one.',
          { autoClose: 4000 }
        );
      }
    } catch (err) {
      Notification.error(
        isResponseStatus(err, 404)
          ? 'That conversation no longer exists - the list has been refreshed.'
          : `Switch failed: ${err}`,
        { autoClose: 4000 }
      );
    } finally {
      // Best-effort refresh - never let a transient failure reject this
      // fire-and-forget switch (callers do not await it).
      await this._fetch().catch(() => undefined);
    }
  }

  /** Delete conversations of the active row's project. Resolves with the
   * removed count, or null on a failure already reported to the user. */
  private async _deleteBranches(
    session: ISession,
    sessionIds: string[]
  ): Promise<number | null> {
    try {
      const result = await requestProvider<IDeleteSessionsResponse>(
        this._descriptor.id,
        'sessions',
        this._serverSettings,
        {
          method: 'DELETE',
          body: JSON.stringify({
            encoded_path: session.encoded_path,
            session_ids: sessionIds
          })
        }
      );
      // A deleted conversation leaves no colour entry behind - but only the
      // ids the server says it removed, so a refused delete keeps its tint.
      await this._colours.forget(result.removed_ids ?? sessionIds);
      // The kept listing names conversations that may have just gone.
      this._branchCache = null;
      return result.removed_count;
    } catch (err) {
      Notification.error(`Delete failed: ${String(err)}`, { autoClose: 4000 });
      return null;
    } finally {
      await this._fetch().catch(() => undefined);
    }
  }

  private async _fetchBranches(session: ISession): Promise<IBranchesResponse> {
    const params: Record<string, string> = {
      encoded_path: session.encoded_path
    };
    // Providers whose conversations can be held by a live worker need that
    // resolved in the same round trip - the menu opens on this response. The
    // name is the server's own (`include_extras`); a core flag that spelled it
    // otherwise was dead on the wire.
    if (this._descriptor.hasBgAgents) {
      params.include_extras = '1';
    }
    return requestProvider<IBranchesResponse>(
      this._descriptor.id,
      withQuery('branches', params),
      this._serverSettings,
      { cache: 'no-store' }
    );
  }

  // -------------------------------------------------------------- rendering

  /** Apply the presentation-mode setting. Basename collisions in name mode are
   * resolved separately in `_disambiguate`. */
  private _displayName(s: ISession): string {
    const folder = this._basename(s.project_path) || s.encoded_path;
    if (this._presentationMode === 'path') {
      return this._displayPath(s.project_path) || folder;
    }
    // Honour the session name the assistant records (e.g. after a rename);
    // fall back to the folder basename when there is none.
    if (s.name_source === 'session' && s.name) {
      return s.name;
    }
    return folder;
  }

  private _basename(p: string): string {
    if (!p) {
      return '';
    }
    const parts = p.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  }

  /** Walk path tails until every name in a colliding group is unique. Name-mode
   * labels are folder basenames, so two different projects can carry the same
   * label; each colliding label is extended with as much of its parent path as
   * it takes to tell them apart. */
  private _disambiguate(rows: ISession[]): Map<string, string> {
    const out = new Map<string, string>();
    const groups = new Map<string, ISession[]>();
    for (const r of rows) {
      const n = this._displayName(r);
      groups.set(n, (groups.get(n) ?? []).concat(r));
    }
    for (const [name, group] of groups.entries()) {
      if (group.length === 1) {
        out.set(group[0].project_path, name);
        continue;
      }
      const segs = group.map(r => r.project_path.split('/').filter(Boolean));
      const max = Math.max(...segs.map(s => s.length));
      let depth = 1;
      let resolved = false;
      while (depth <= max) {
        const tails = segs.map(s => s.slice(-depth).join('/'));
        if (new Set(tails).size === tails.length) {
          group.forEach((r, i) => out.set(r.project_path, tails[i]));
          resolved = true;
          break;
        }
        depth += 1;
      }
      if (!resolved) {
        // Identical project paths across rows should not happen, but if they
        // ever do, the absolute path keeps rows distinguishable.
        group.forEach(r => out.set(r.project_path, r.project_path));
      }
    }
    return out;
  }

  private _render(): void {
    const sessions = this._sessions ?? [];

    // Capture scrollTop per section so a polling refresh does not reset the
    // user's place. The body scrolls too in short windows - clearing innerHTML
    // clamps its scrollTop to 0, so it needs the same capture and restore.
    const bodyScroll = this._bodyEl.scrollTop;
    const scrolls = new Map<string, number>();
    this._bodyEl
      .querySelectorAll<HTMLElement>('.jp-AiAssistantsPanel-section')
      .forEach(sect => {
        const key = sect.dataset.section;
        const list = sect.querySelector<HTMLElement>(
          '.jp-AiAssistantsPanel-list'
        );
        if (key && list) {
          scrolls.set(key, list.scrollTop);
        }
      });

    // The focused row, so a 30s poll landing mid-keyboard-navigation does not
    // drop focus to <body> and make the user tab back from the top. The
    // scroll offsets a few lines up are saved for the same reason.
    const active =
      document.activeElement instanceof HTMLElement &&
      this._bodyEl.contains(document.activeElement)
        ? document.activeElement
        : null;
    // Section AND row: the same project renders into Favorites, Recent and All
    // at once, so the row key alone would restore focus to a different copy -
    // and scroll the list to it. Section headers have no row key, so they
    // carry their own.
    const focusedSection =
      active?.closest<HTMLElement>('.jp-AiAssistantsPanel-section')?.dataset
        .section ?? null;
    const focusedPath = active?.dataset.encodedPath ?? null;
    const focusedHeader = active?.classList.contains(
      'jp-AiAssistantsPanel-sectionHeader'
    );
    this._bodyEl.innerHTML = '';

    if (sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'jp-AiAssistantsPanel-empty';
      empty.textContent = `No ${this._descriptor.label} sessions found.`;
      this._bodyEl.appendChild(empty);
      // The first-run state has to name the next step - the header's + button
      // is the only way out of it.
      const hint = document.createElement('div');
      hint.className = 'jp-AiAssistantsPanel-empty';
      hint.textContent = 'Use + to start a session in the current folder.';
      this._bodyEl.appendChild(hint);
      return;
    }

    // Disambiguated names are computed once per render against the FULL set,
    // so suffixes stay stable when a filter narrows the view.
    this._displayNames = this._disambiguate(sessions);

    const filtered = sessions.filter(s => this._matchesFilter(s));
    const favourites = filtered.filter(s => s.favourite);
    const recent = [...filtered]
      .sort((a, b) => b.file_mtime - a.file_mtime)
      .slice(0, this._recentLimit);
    const all = [...filtered].sort((a, b) =>
      this._lookupName(a).localeCompare(this._lookupName(b))
    );

    // Rendered whenever the user HAS favourites, not whenever the filter
    // matches one: dropping the heading leaves them unable to tell a filter
    // miss from lost stars, and makes the section's own empty state - which
    // the comment below documents as live - unreachable.
    if (favourites.length > 0 || this._sessions?.some(s => s.favourite)) {
      this._renderSection('favourites', favourites);
    }
    // Recent is a shortcut into the top of All, so it earns a heading only
    // while it is genuinely shorter: below the limit both sections list the
    // same projects under two headings, which is the default state for anyone
    // with fewer than `recentLimit` of them (DEF-44). Measured against the
    // UNFILTERED count for the reason Favorites is - a section that vanishes
    // while the user types cannot be told from one that lost its rows.
    if (sessions.length > this._recentLimit) {
      this._renderSection('recent', recent);
    }
    this._renderSection('all', all);

    this._bodyEl
      .querySelectorAll<HTMLElement>('.jp-AiAssistantsPanel-section')
      .forEach(sect => {
        const key = sect.dataset.section;
        const list = sect.querySelector<HTMLElement>(
          '.jp-AiAssistantsPanel-list'
        );
        const saved = key ? scrolls.get(key) : undefined;
        if (list && saved !== undefined) {
          list.scrollTop = saved;
        }
      });
    this._bodyEl.scrollTop = bodyScroll;
    if (focusedSection) {
      const section = this._bodyEl.querySelector<HTMLElement>(
        `.jp-AiAssistantsPanel-section[data-section="${CSS.escape(
          focusedSection
        )}"]`
      );
      const target = focusedHeader
        ? section?.querySelector<HTMLElement>(
            '.jp-AiAssistantsPanel-sectionHeader'
          )
        : focusedPath
          ? section?.querySelector<HTMLElement>(
              `.jp-AiAssistantsPanel-row[data-encoded-path="${CSS.escape(
                focusedPath
              )}"]`
            )
          : null;
      // preventScroll, or the restore undoes the offsets set two lines up.
      target?.focus({ preventScroll: true });
    }
  }

  private _renderSection(key: SectionKey, items: ISession[]): void {
    const section = document.createElement('div');
    section.className = 'jp-AiAssistantsPanel-section';
    section.dataset.section = key;
    const expanded = this._expanded[key];

    const header = document.createElement('button');
    header.className = 'jp-AiAssistantsPanel-sectionHeader';
    header.setAttribute('aria-expanded', String(expanded));

    const caret = document.createElement('span');
    caret.className = 'jp-AiAssistantsPanel-caret';
    caret.textContent = expanded ? '▾' : '▸';
    // Decorative - the state it draws is already on the header's aria-expanded.
    caret.setAttribute('aria-hidden', 'true');
    header.appendChild(caret);

    const label = document.createElement('span');
    label.className = 'jp-AiAssistantsPanel-sectionLabel';
    label.textContent = `${SECTION_LABELS[key]} (${items.length})`;
    header.appendChild(label);

    header.addEventListener('click', () => {
      this._expanded[key] = !this._expanded[key];
      saveExpanded(this._expandedKey, this._expanded);
      this._render();
    });
    section.appendChild(header);

    if (expanded) {
      const list = document.createElement('div');
      list.className = 'jp-AiAssistantsPanel-list';
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'jp-AiAssistantsPanel-emptySection';
        // Only a filter can empty a section: the panel returns early when
        // there are no sessions at all, an empty filter matches every row,
        // and Recent's limit is clamped to at least one.
        empty.textContent = 'No matches.';
        list.appendChild(empty);
      } else {
        // Roving tabindex: the section holds ONE tab stop, not one per row.
        // The same project renders into Favorites, Recent and All at once, so
        // a stop per row made Tab visit that project three times before it
        // left the panel. The remembered row survives a re-render; when it is
        // gone - filtered out, or never set - the stop falls to the first row.
        const stop =
          items.find(i => i.encoded_path === this._roving[key])?.encoded_path ??
          items[0].encoded_path;
        for (const item of items) {
          list.appendChild(
            this._renderRow(item, key, item.encoded_path === stop)
          );
        }
      }
      section.appendChild(list);
    }

    this._bodyEl.appendChild(section);
  }

  private _renderRow(
    session: ISession,
    sectionKey: SectionKey,
    isTabStop: boolean
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'jp-AiAssistantsPanel-row';
    row.title = this._buildRowTooltip(session);
    // The row IS the primary control - without these it is reachable by mouse
    // only, and so is the context menu that carries every other action.
    row.setAttribute('role', 'button');
    // -1 is still focusable programmatically, which is what the arrow keys
    // below and the post-render focus restore both use.
    row.tabIndex = isTabStop ? 0 : -1;
    // Identity across a re-render, so the poll can put focus back where the
    // user left it.
    row.dataset.encodedPath = session.encoded_path;

    // Age emphasis: active within the last minute reads bright, idle over a
    // week dims; both decay or promote on the next refresh.
    if (session.file_mtime) {
      const age = Date.now() - session.file_mtime;
      if (age < 60_000) {
        row.classList.add('jp-mod-recentlyActive');
      } else if (age > 7 * 86_400_000) {
        row.classList.add('jp-mod-stale');
      }
    }

    const removing = this._removingPaths.has(session.encoded_path);
    if (removing) {
      row.classList.add('jp-mod-busy');
      const spinner = document.createElement('span');
      spinner.className = 'jp-AiAssistantsPanel-spinner';
      spinner.title = 'Removing...';
      row.appendChild(spinner);
    } else {
      row.appendChild(this._renderIndicator(session));
    }

    const name = document.createElement('span');
    name.className = 'jp-AiAssistantsPanel-name';
    // The text ellipsises in a span of its own so the badges after it survive
    // truncation: appended into the ellipsising span they were clipped away
    // entirely at sidebar width, on exactly the long-named rows (DEF-41). Same
    // structure the Manage Sessions popup's branch rows already use.
    const nameText = document.createElement('span');
    nameText.className = 'jp-AiAssistantsPanel-nameText';
    nameText.textContent = this._lookupName(session);
    name.appendChild(nameText);
    // Branch icon plus total conversation count, only when the project holds
    // more than one. Inside the name span so it hugs the label text instead of
    // being flexed to the row's right edge.
    if (session.extra_sessions > 0) {
      const badge = document.createElement('span');
      badge.className = 'jp-AiAssistantsPanel-branchBadge';
      const icon = document.createElement('span');
      icon.className = 'jp-AiAssistantsPanel-branchBadgeIcon';
      branchIcon.element({ container: icon });
      badge.appendChild(icon);
      badge.appendChild(
        document.createTextNode(String(session.extra_sessions + 1))
      );
      name.appendChild(badge);
    }
    // A live worker owns this conversation, so a click joins it rather than
    // resuming a dormant one. Marked so the difference is visible before the
    // click, not a surprise after it. No own title: a child title shadows the
    // row's, which would hide the path behind a two-character chip.
    if (this._descriptor.hasBgAgents && session.bg_id) {
      const bg = document.createElement('span');
      bg.className = 'jp-AiAssistantsPanel-bgBadge';
      bg.textContent = 'bg';
      name.appendChild(bg);
    }
    row.appendChild(name);

    // No star in the Favorites section - every row there is one by definition.
    // The star sits before the time so the fixed-width time column stays the
    // rightmost alignment anchor across all rows.
    if (session.favourite && sectionKey !== 'favourites') {
      // A marker, not a control. It carried a `title` that made it read as
      // one while a click fell through to the row and launched a terminal;
      // un-starring stays where every other row action lives, in the context
      // menu, rather than becoming a second hit target inside the row.
      const star = document.createElement('span');
      star.className = 'jp-AiAssistantsPanel-favStar';
      star.setAttribute('aria-label', 'Favorite');
      star.setAttribute('role', 'img');
      starFilledIcon.element({ container: star });
      row.appendChild(star);
    }

    // Always present (empty without an mtime) so the star column keeps the
    // same anchor across every row in the panel.
    const time = document.createElement('span');
    time.className = 'jp-AiAssistantsPanel-rowTime';
    time.textContent = session.file_mtime
      ? this._formatRelativeTime(session.file_mtime)
      : '';
    row.appendChild(time);

    row.addEventListener('click', () => {
      if (removing) {
        return;
      }
      void this._openSession(session);
    });
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (removing) {
        return;
      }
      this._activeSession = session;
      this._setActiveRow(row);
      void this._openContextMenu(session, e.clientX, e.clientY);
    });
    // The tab stop follows the focus, so tabbing out of the panel and back
    // returns to the row the user left rather than to the top of the section.
    // Focus arrives here from a click, an arrow key, or the post-render
    // restore, and all three should move the stop.
    row.addEventListener('focus', () => {
      this._roving[sectionKey] = session.encoded_path;
      for (const sibling of this._rowsBeside(row)) {
        sibling.tabIndex = sibling === row ? 0 : -1;
      }
    });
    row.addEventListener('keydown', e => {
      // Arrow keys move within the section - between sections is what the
      // section headers, which are tab stops of their own, are for. Live even
      // while the row is busy: moving the focus off a row being removed is
      // exactly what a user needs to be able to do.
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (step !== 0 || e.key === 'Home' || e.key === 'End') {
        // Or the list scrolls under the moving focus.
        e.preventDefault();
        const rows = this._rowsBeside(row);
        const at = rows.indexOf(row);
        const to =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? rows.length - 1
              : // Clamped, not wrapped: at either end the arrow does nothing,
                // so the ends of the list stay findable by feel.
                Math.min(rows.length - 1, Math.max(0, at + step));
        rows[to]?.focus();
        return;
      }
      if (removing) {
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        // Space would scroll the list otherwise.
        e.preventDefault();
        void this._openSession(session);
        return;
      }
      // The two keyboard routes to a context menu. Anchored on the row's own
      // rect, since there is no pointer to anchor on.
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        this._activeSession = session;
        this._setActiveRow(row);
        const rect = row.getBoundingClientRect();
        void this._openContextMenu(session, rect.left, rect.bottom);
      }
    });

    return row;
  }

  /** The rows of one section, in render order - the row itself included. */
  private _rowsBeside(row: HTMLElement): HTMLElement[] {
    return Array.from(
      row.parentElement?.querySelectorAll<HTMLElement>(
        '.jp-AiAssistantsPanel-row'
      ) ?? []
    );
  }

  /** Leading status dot, or a placeholder that reserves its column. Which
   * states exist is a descriptor question, never an assistant question. */
  private _renderIndicator(session: ISession): HTMLElement {
    const dot = document.createElement('span');
    // A `title` alone is not announced by most screen readers, so the same
    // words go on an aria-label.
    if (this._descriptor.hasRemoteControl && session.remote_control) {
      dot.className = 'jp-AiAssistantsPanel-dot';
      dot.title = 'Remote control session is active';
      dot.setAttribute('aria-label', dot.title);
      return dot;
    }
    if (this._descriptor.hasLiveProcess && session.live) {
      dot.className = 'jp-AiAssistantsPanel-dot';
      dot.title = `A ${this._descriptor.label} session is active in this project`;
      dot.setAttribute('aria-label', dot.title);
      return dot;
    }
    dot.className = 'jp-AiAssistantsPanel-dotPlaceholder';
    return dot;
  }

  private _lookupName(s: ISession): string {
    return this._displayNames.get(s.project_path) ?? this._displayName(s);
  }

  private _buildRowTooltip(s: ISession): string {
    const lines: string[] = [this._lookupName(s)];
    lines.push(`Path: ${this._displayPath(s.project_path)}`);
    if (s.file_mtime) {
      // Absolute first: the tooltip is the one place an exact reference fits,
      // and the relative value is already on the row.
      lines.push(
        `Last activity: ${this._formatAbsoluteTime(
          s.file_mtime
        )} (${this._formatRelativeTime(s.file_mtime)})`
      );
    }
    if (s.message_count) {
      lines.push(`Messages: ${s.message_count}`);
    }
    if (s.extra_sessions > 0) {
      lines.push(`Conversations: ${s.extra_sessions + 1}`);
    }
    if (s.git_branch) {
      lines.push(`Branch: ${s.git_branch}`);
    }
    if (this._descriptor.hasRemoteControl && s.remote_control) {
      lines.push('Remote control: active');
    }
    if (this._descriptor.hasLiveProcess && s.live) {
      lines.push('Status: active');
    }
    if (this._descriptor.hasBgAgents && s.bg_id) {
      lines.push(`Background agent: ${s.bg_id} (click attaches to it)`);
    }
    lines.push(...(this._hooks.tooltipLines?.(s) ?? []));
    // What THIS row's click resolves to, which is the attach-aware question:
    // the line above may have just said the click joins a live worker, and an
    // attach is issued before the mode is appended, so `_resolvedVariant`
    // promised a flag the server discards - one tooltip naming both, a line
    // apart (DEF-46).
    const variant = this._resumeVariant(s);
    if (variant) {
      // The row click launches with this, and the menu is the only other place
      // that says so.
      lines.push(`Launch mode: ${variant.label}`);
    }
    if (s.session_id) {
      lines.push(`Session id: ${s.session_id}`);
    }
    return lines.join('\n');
  }

  private _displayPath(absolute: string): string {
    if (!this._rootDir) {
      return absolute;
    }
    if (absolute === this._rootDir) {
      return '.';
    }
    if (absolute.startsWith(this._rootDir + '/')) {
      return absolute.slice(this._rootDir.length + 1);
    }
    return absolute;
  }

  /** Path relative to the JupyterLab server root (`''` for the root itself),
   * or null when the folder lies outside it - in which case the file browser
   * has no way to address it. */
  private _pathUnderRoot(absolute: string): string | null {
    if (!this._rootDir) {
      return null;
    }
    if (absolute === this._rootDir) {
      return '';
    }
    // `/` is its own separator, so the prefix must not gain a second one -
    // otherwise every path under a server rooted at `/` reads as outside it.
    const prefix = this._rootDir === '/' ? '/' : this._rootDir + '/';
    if (absolute.startsWith(prefix)) {
      return absolute.slice(prefix.length);
    }
    return null;
  }

  private _formatRelativeTime(epochMs: number): string {
    if (!epochMs) {
      return 'unknown';
    }
    const diff = Date.now() - epochMs;
    if (diff < 60_000) {
      return 'now';
    }
    if (diff < 3_600_000) {
      return `${Math.floor(diff / 60_000)}m ago`;
    }
    if (diff < 86_400_000) {
      return `${Math.floor(diff / 3_600_000)}h ago`;
    }
    if (diff < 30 * 86_400_000) {
      return `${Math.floor(diff / 86_400_000)}d ago`;
    }
    if (diff < 365 * 86_400_000) {
      return `${Math.floor(diff / (30 * 86_400_000))}mo ago`;
    }
    return `${Math.floor(diff / (365 * 86_400_000))}y ago`;
  }

  /** Local `YYYY-MM-DD HH:MM` - the absolute reference the relative label
   * cannot give. */
  private _formatAbsoluteTime(epochMs: number): string {
    const d = new Date(epochMs);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }

  /** Branch entry display: conversation name plus short session id. Branches
   * share a project path, so the name and id are all that tell them apart. The
   * suffix is dropped when the label already IS the short id. */
  private _branchDisplayName(b: IBranch): string {
    const shortId = b.session_id.slice(0, 8);
    if (this._hooks.branchLabel) {
      return this._hooks.branchLabel(b, shortId);
    }
    return b.label === shortId ? b.label : `${b.label} (${shortId})`;
  }

  /** Menu-item label for a branch: display name, relative time, and a trailing
   * marker when a live worker owns the conversation. The marker lives in the
   * label rather than the icon, because both branch submenus need their icon
   * slot for their own intent, and words are what assistive tech reads. */
  private _branchMenuLabel(b: IBranch): string {
    const time = this._formatRelativeTime(b.file_mtime);
    const bg = this._descriptor.hasBgAgents && b.bg_id ? ' (bg)' : '';
    return `${this._branchDisplayName(b)} - ${time}${bg}`;
  }

  private _setRefreshSpinning(on: boolean): void {
    this._refreshBtn?.classList.toggle('jp-mod-spinning', on);
  }

  private _setActiveRow(row: HTMLElement | null): void {
    if (this._activeRowEl && this._activeRowEl !== row) {
      this._activeRowEl.classList.remove('jp-mod-active');
    }
    this._activeRowEl = row;
    row?.classList.add('jp-mod-active');
  }

  // --------------------------------------------------------------- commands

  private _cmd(action: string): string {
    return commandId(this._descriptor.id, action);
  }

  /** Launch modes that produce a menu variant - the assistant's own
   * skip-approval switch, under the assistant's own name. */
  private get _variantModes(): ILaunchMode[] {
    return this._descriptor.launchModes.filter(m => !!m.menuLabel);
  }

  /** The launch mode a PLAIN action resolves to right now, or null.
   *
   * Every marking below hangs off this rather than off `force`, because a mode
   * left on in settings is applied to the plain items too: marking only the
   * forced variant then puts the warning on the SAFER-looking of two entries
   * that build a byte-identical launch, and the unmarked one is the default
   * the user clicks. */
  private _resolvedVariant(): IResolvedLaunchMode | null {
    const resolved = resolvedLaunchModeEntry(
      this._descriptor.launchModes,
      this._modes
    );
    return resolved;
  }

  /** The same mode as it applies to RESUME - of the active row by default, or
   * of whichever conversation is named.
   *
   * An attach is not a launch: the server returns the argv before the flag is
   * appended, deliberately, so promising the mode on a conversation a live
   * worker already holds would name something the assistant never receives.
   * That is true of resuming and of nothing else, so it is tested HERE rather
   * than in `_resolvedVariant` - which is read by the `+` button and both
   * new-session and branch items, none of which attach. Testing it there let
   * one right-click on a background-agent row strip the mode's name off every
   * one of those surfaces panel-wide, while their launches went on carrying it
   * (DEF-37).
   *
   * The argument is what lets a surface that describes SOMEONE ELSE'S resume -
   * a row tooltip built during a render, a branch item in the submenu - ask the
   * question about that conversation rather than about the active row.
   */
  private _resumeVariant(
    target: { bg_id?: string | null } | null = this._activeSession
  ): IResolvedLaunchMode | null {
    const joining = this._descriptor.hasBgAgents && !!target?.bg_id;
    return joining ? null : this._resolvedVariant();
  }

  /** The variant suffix a plain item wears while that mode is in force. */
  private _variantSuffix(): string {
    const resolved = this._resolvedVariant();
    return resolved ? ` (${resolved.label})` : '';
  }

  /** Whether a forced variant would build the launch the plain item already
   * builds - a mode left on in settings makes the plain item carry it, so the
   * variant beside it would be a second entry for one outcome. Only a boolean
   * variant can match: a forced token is the bare mode id, so an enum sitting
   * on a widening value is a launch no variant duplicates. */
  private _buildsSameLaunch(mode: ILaunchMode): boolean {
    const forced = resolveLaunchMode(
      this._descriptor.launchModes,
      this._modes,
      mode.id
    );
    return !!forced && forced === this._launchMode();
  }

  /** The glyph, only where the mode WIDENS what runs without asking. */
  private _variantIcon(): LabIcon | undefined {
    return this._resolvedVariant()?.unsafe ? shieldIcon : undefined;
  }

  private _setupCommands(): void {
    this._commands = new CommandRegistry();
    const active = (): ISession | null => this._activeSession;

    this._commands.addCommand(this._cmd('toggle-favourite'), {
      label: () =>
        active()?.favourite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: starFilledIcon,
      execute: () => {
        const s = active();
        if (s) {
          void this._toggleFavourite(s);
        }
      }
    });

    this._commands.addCommand(this._cmd('resume'), {
      // Joining a live worker and resuming a dormant conversation are
      // different verbs, so a provider that has both says which one this row
      // gets.
      label: () => {
        const variant = this._resumeVariant();
        const verb = this._hooks.resumeLabel?.(active()) ?? 'Resume';
        return variant ? `${verb} (${variant.label})` : verb;
      },
      icon: () => (this._resumeVariant()?.unsafe ? shieldIcon : undefined),
      execute: () => {
        const s = active();
        if (s) {
          void this._openSession(s);
        }
      }
    });

    for (const mode of this._variantModes) {
      this._commands.addCommand(this._cmd(`resume-${mode.id}`), {
        label: `Resume (${mode.menuLabel})`,
        icon: shieldIcon,
        // Absent while the plain item already resolves to this same mode - it
        // would be a second entry building an identical launch.
        isVisible: () => !this._buildsSameLaunch(mode),
        // A conversation a live worker already holds was started in whatever
        // mode that worker has; joining it cannot change that, so the variant
        // is disabled rather than silently joining in the wrong mode.
        isEnabled: () => !(this._descriptor.hasBgAgents && active()?.bg_id),
        execute: () => {
          const s = active();
          if (s) {
            void this._openSession(s, mode.id);
          }
        }
      });
      this._commands.addCommand(this._cmd(`new-session-${mode.id}`), {
        label: `New session (${mode.menuLabel})`,
        icon: shieldIcon,
        isVisible: () => !this._buildsSameLaunch(mode),
        execute: () => void this._newSession(mode.id)
      });
      this._commands.addCommand(this._cmd(`branch-session-${mode.id}`), {
        label: mode.menuLabel as string,
        icon: shieldIcon,
        isVisible: () => !this._buildsSameLaunch(mode),
        execute: () => void this._branchSession(mode.id)
      });
    }

    this._commands.addCommand(this._cmd('open-terminal'), {
      label: 'Open Terminal',
      icon: terminalIcon,
      execute: () => {
        const s = active();
        if (!s) {
          return;
        }
        // JupyterLab's own command spawns a plain shell at the given cwd. That
        // cwd is interpreted relative to the contents manager root, not as an
        // absolute filesystem path, so it goes through _pathUnderRoot.
        const rel = this._pathUnderRoot(s.project_path);
        if (rel === null) {
          // A root the server has not sent yet is not a folder outside it
          // (DEF-134).
          Notification.warning(
            this._rootDir
              ? 'Folder is outside the JupyterLab root - cannot open a terminal there.'
              : 'Waiting for the server root - cannot open a terminal yet.',
            { autoClose: 4000 }
          );
          return;
        }
        this._app.commands
          .execute('terminal:create-new', { cwd: rel })
          .catch(err =>
            this._showActionError(
              'Could not open a terminal for this session - try again.',
              err
            )
          );
      }
    });

    this._commands.addCommand(this._cmd('show-in-filebrowser'), {
      label: 'Show in File Browser',
      icon: folderIcon,
      execute: () => {
        const s = active();
        if (!s) {
          return;
        }
        const rel = this._pathUnderRoot(s.project_path);
        if (rel === null) {
          // A root the server has not sent yet is not a folder outside it
          // (DEF-134).
          Notification.warning(
            this._rootDir
              ? 'Folder is outside the JupyterLab root - the file browser cannot show it.'
              : 'Waiting for the server root - the file browser cannot show it yet.',
            { autoClose: 4000 }
          );
          return;
        }
        this._app.commands
          .execute('filebrowser:go-to-path', { path: rel })
          .catch(err =>
            this._showActionError(
              'Could not open the project folder - try again.',
              err
            )
          );
      }
    });

    this._commands.addCommand(this._cmd('copy-path'), {
      label: 'Copy Path',
      execute: () => {
        const s = active();
        if (s) {
          Clipboard.copyToSystem(s.project_path);
        }
      }
    });

    this._commands.addCommand(this._cmd('copy-session-id'), {
      label: 'Copy Session ID',
      execute: () => {
        const id = active()?.session_id;
        if (id) {
          Clipboard.copyToSystem(id);
        }
      }
    });

    // The only way back out of a hand-set tab colour. The colourful-tab
    // extension's own Clear touches its storage and the tab's classes, neither
    // of which this extension reads once the colour is in its store, so
    // without this item the override would be permanent - and on a native
    // assistant that means `/color` silently never showing again.
    //
    // It covers every conversation of the row, not just the current one: a
    // terminal opened on a branch files its colour under THAT branch, and this
    // row is the only surface offering the release. Absent while tab colouring
    // is off, where a reset would change nothing on screen. The count is on
    // the label because the conversations it reaches are not all on the row -
    // even at one, which may be a branch whose tab is not open - and every
    // other multi-target item in this menu names its number too.
    this._commands.addCommand(this._cmd('reset-colour'), {
      label: () => {
        const n = this._resettableColours.length;
        return n > 1 ? `Reset Tab Colours (${n})` : `Reset Tab Colour (${n})`;
      },
      isVisible: () => this._colouredTabs && this._resettableColours.length > 0,
      execute: () => void this._resetColours(this._resettableColours)
    });

    this._commands.addCommand(this._cmd('cleanup-parallel'), {
      label: () =>
        `Clean Up Parallel Sessions (${active()?.extra_sessions ?? 0})`,
      // Marked, like `Remove from ...` below it. The two share the group the
      // separator was added to protect, and both delete history that cannot be
      // recovered; leaving this one bare made the pair read as one dangerous
      // item beside an ordinary one (DEF-45). The sweep variant of the trash
      // glyph, because this one deletes several at once.
      icon: cleanupIcon,
      isVisible: () => (active()?.extra_sessions ?? 0) > 0,
      execute: () => {
        const s = active();
        if (s) {
          void this._cleanupParallel(s);
        }
      }
    });

    this._commands.addCommand(this._cmd('switch-branch'), {
      label: args => String(args.label ?? ''),
      // The icon column carries the submenu's INTENT, never the row's state:
      // both branch submenus list the same conversations with the same labels,
      // so a state-driven icon would render them identically and a pointer
      // slip would switch the current conversation instead of opening one.
      icon: switchIcon,
      execute: args => {
        const s = active();
        const sessionId = String(args.session_id ?? '');
        if (s && sessionId) {
          void this._switchBranch(s, sessionId);
        }
      }
    });

    this._commands.addCommand(this._cmd('manage-sessions'), {
      label: () => `Manage Sessions... (${this._lastBranches.length})`,
      execute: () => this._openManagePopup()
    });

    this._commands.addCommand(this._cmd('open-branch'), {
      // Names the mode the launch carries, like Resume, `+` and Branch Session
      // do - this item opens a terminal, so the mode in force applies to it and
      // this was the one launch surface that stayed silent about it. Attach-
      // aware per conversation: the submenu passes `bg`, since a branch a live
      // worker holds is attached to and takes no mode (DEF-46's rule).
      label: args => {
        const base = String(args.label ?? '');
        const variant = this._resumeVariant(
          args.bg ? { bg_id: String(args.bg) } : null
        );
        return variant ? `${base} (${variant.label})` : base;
      },
      // Intent glyph, not row state - see switch-branch above.
      icon: terminalIcon,
      execute: args => {
        const s = active();
        const sessionId = String(args.session_id ?? '');
        if (s && sessionId) {
          void this._openSession(s, undefined, sessionId);
        }
      }
    });

    this._commands.addCommand(this._cmd('branch-session'), {
      // Two positions, two identities. Inside the submenu the title already
      // says Branch Session, so the item only has to name WHICH launch it is.
      // Flattened to the top level - which happens exactly when every variant
      // suppresses itself - that title is gone with it, and an item reading
      // `Default (Bypass Approvals)`, or bare `Normal` on a row holding a
      // background agent, names no verb at all while sitting one row above the
      // entries that delete history (DEF-35).
      label: () =>
        this._visibleVariantCount() === 0
          ? `Branch Session${this._variantSuffix()}`
          : this._variantSuffix()
            ? `Default${this._variantSuffix()}`
            : 'Normal',
      // The suffix names the mode in words, but the icon slot is what marks
      // danger everywhere else in this menu - spending it on a branch glyph
      // left `Branch Session (Skip Permissions)` looking exactly as safe as
      // Show in File Browser while `Resume (Skip Permissions)` beside it wore
      // the shield. The branch glyph is the fallback, not the winner.
      icon: () =>
        this._variantIcon() ??
        (this._visibleVariantCount() === 0 ? branchIcon : undefined),
      execute: () => void this._branchSession()
    });

    this._commands.addCommand(this._cmd('remove'), {
      label: `Remove from ${this._descriptor.label}`,
      icon: removeIcon,
      execute: () => {
        const s = active();
        if (s) {
          void this._removeProject(s);
        }
      }
    });

    this._commands.addCommand(this._cmd('new-session'), {
      label: () => `New session${this._variantSuffix()}`,
      icon: () => this._variantIcon(),
      execute: () => void this._newSession()
    });

    this._buildMenus();
  }

  /** How many forced launch variants would actually render right now. Zero
   * means every variant builds the launch the plain item already builds, so a
   * menu offering both is a menu with one entry. */
  private _visibleVariantCount(): number {
    return this._variantModes.filter(m => !this._buildsSameLaunch(m)).length;
  }

  private _buildMenus(): void {
    // Dropdown for the header's plus button - same registry and styling as the
    // row context menu.
    this._newSessionMenu = this._menu();
    this._newSessionMenu.addItem({ command: this._cmd('new-session') });
    for (const mode of this._variantModes) {
      this._newSessionMenu.addItem({
        command: this._cmd(`new-session-${mode.id}`)
      });
    }

    // Lists the project's other conversations. Items are rebuilt on every
    // context-menu open from a fresh branches fetch.
    this._switchSubmenu = this._menu();
    this._switchSubmenu.title.label = 'Switch and Manage Sessions';
    this._switchSubmenu.title.icon = switchIcon;

    // Opens a conversation directly in its own terminal, as opposed to the
    // switch submenu which only changes which one the row points at. Several
    // conversations can be open at once, independently.
    this._openBranchSubmenu = this._menu();
    this._openBranchSubmenu.title.label = 'Open Branched Conversation';
    this._openBranchSubmenu.title.icon = terminalIcon;

    // Groups the branch launch modes.
    this._branchSessionMenu = this._menu();
    this._branchSessionMenu.title.label = 'Branch Session';
    this._branchSessionMenu.title.icon = branchIcon;
    this._branchSessionMenu.addItem({ command: this._cmd('branch-session') });
    for (const mode of this._variantModes) {
      this._branchSessionMenu.addItem({
        command: this._cmd(`branch-session-${mode.id}`)
      });
    }

    this._contextMenu = this._menu();
    this._rebuildContextMenu(false);

    this._contextMenu.aboutToClose.connect(() => {
      // Only clear the visual highlight - do NOT null _activeSession. Lumino
      // fires aboutToClose BEFORE the activated item's command runs, so the
      // callback still needs to read it. The field is overwritten on the next
      // contextmenu open.
      this._setActiveRow(null);
    });
  }

  private _menu(): Menu {
    // MenuSvg, not a plain Lumino Menu. Lumino's default renderer emits
    // `div.lm-Menu-itemSubmenuIcon` EMPTY, so every submenu here drew no caret
    // and `Branch Session`, which opens on hover, read exactly like the items
    // that act on click (DEF-42). MenuSvg's renderer is the one JupyterLab's
    // own menus use: it fills that div with the caret glyph, and otherwise
    // differs only in adding the stock menu-item icon sizing our items already
    // get from `base.css`.
    const menu = new MenuSvg({ commands: this._commands });
    menu.addClass('jp-AiAssistantsContextMenu');
    return menu;
  }

  /** Rebuild the context menu's items. Lumino submenu items have no
   * `isVisible` hook, so the menu is rebuilt per open and a branch submenu is
   * inserted only when the row actually has branches - a capability the
   * provider lacks is absent, not shown and disabled. */
  private _rebuildContextMenu(withBranches: boolean): void {
    this._contextMenu.clearItems();
    const add = (action: string): void => {
      this._contextMenu.addItem({ command: this._cmd(action) });
    };

    add('resume');
    for (const mode of this._variantModes) {
      add(`resume-${mode.id}`);
    }
    add('open-terminal');
    add('show-in-filebrowser');
    add('toggle-favourite');
    add('copy-path');
    add('copy-session-id');
    add('reset-colour');
    this._contextMenu.addItem({ type: 'separator' });
    if (withBranches) {
      this._contextMenu.addItem({
        type: 'submenu',
        submenu: this._openBranchSubmenu
      });
      this._contextMenu.addItem({
        type: 'submenu',
        submenu: this._switchSubmenu
      });
    }
    // A submenu holding one entry is a hover for nothing - it happens whenever
    // a mode is in force and the variant suppresses itself, same as the plus
    // button above.
    if (this._visibleVariantCount() === 0) {
      add('branch-session');
    } else {
      this._contextMenu.addItem({
        type: 'submenu',
        submenu: this._branchSessionMenu
      });
    }
    // The two entries that delete history get their own group. Lumino opens a
    // submenu on hover, so the pointer travels down-RIGHT across Branch
    // Session to reach its items and a slip lands here; a separator is the
    // only thing between that slip and a project's history.
    this._contextMenu.addItem({ type: 'separator' });
    add('cleanup-parallel');
    add('remove');
  }

  /** Open the row context menu, populating the branch submenus first when the
   * project holds more than one conversation. A fetch failure - or one too
   * slow to wait for - opens the menu without them rather than not at all.
   *
   * Everything before the menu is built is raced against one budget, because
   * every await here is a window in which the user right-clicks again. A
   * superseded open touches nothing: `clearItems` CLOSES an attached menu, so
   * a late arrival would shut the menu on screen and reopen its own elsewhere,
   * leaving `Remove` pointed at a project the user had abandoned - and a late
   * arrival that only refilled the submenus would leave the visible menu
   * listing another project's conversations under this one's label. */
  private async _openContextMenu(
    session: ISession,
    x: number,
    y: number
  ): Promise<void> {
    const generation = ++this._menuGeneration;
    // Fetched into a LOCAL. Nothing this open learns may reach a field or a
    // submenu before the guard below: those are read by whichever menu is on
    // screen, so a loser writing them retargets someone else's menu - down to
    // `Reset Tab Colours` dropping the colours of a project the user is not
    // looking at, since the colour store is keyed by provider, not by project.
    const branches = async (): Promise<IBranchesResponse | null> => {
      if (session.extra_sessions <= 0) {
        return null;
      }
      try {
        const fetched = await this._fetchBranches(session);
        // Kept under the project it describes, even when this open has already
        // given up on it: a project whose listing outruns the budget would
        // otherwise never show its branch submenus on ANY open. Never
        // `_lastBranches` - that is the menu's own state and is written after
        // the guard, for the row being opened, by whoever wins.
        this._branchCache = { path: session.encoded_path, data: fetched };
        return fetched;
      } catch {
        return null;
      }
    };
    // The reconcile is what MOVES a colour just picked on a tab into the
    // store, so without it the release stays invisible until the next tick -
    // the whole first half-minute after the gesture that creates the need.
    const colours = this._colours
      .load()
      .then(() => this._terminals.reconcileColours());

    // Nothing here may hold the menu hostage. `requestAPI` is bounded, but at
    // 60s - seventy-five times this budget - so a suspended connection would
    // otherwise cost the user Open, Copy Path and Remove for up to a minute;
    // past the budget the menu opens on what is already cached, and the work
    // completes for the next right-click.
    const data = await Promise.race([
      Promise.all([branches(), colours]).then(([fetched]) => fetched),
      new Promise<IBranchesResponse | null>(resolve =>
        window.setTimeout(() => resolve(null), MENU_STATE_BUDGET_MS)
      )
    ]);
    if (generation !== this._menuGeneration) {
      return;
    }
    // A fetch that lost the race may have landed since, or on an earlier open.
    // Only when one was actually attempted: `branches()` also answers null for
    // a row with no other conversations, and serving the cache there would
    // resurrect a list the user has just cleaned up - submenus offering
    // conversations that no longer exist, on every open, for good.
    const known =
      data ??
      (session.extra_sessions > 0 &&
      this._branchCache?.path === session.encoded_path
        ? this._branchCache.data
        : null);
    const branchList: IBranch[] = known?.branches ?? [];
    const hasBranches = branchList.length > 0;
    if (known) {
      this._lastBranches = branchList;
      this._lastBranchesCurrent = known.current;
      this._fillBranchSubmenus(branchList);
    }
    // Hand-set colours only. A branch's inherited tint is its identity, not a
    // preference to take back - offering it here would let one click scatter
    // every fork of the project to an unrelated colour. A branch list that did
    // not arrive narrows the scope to the row's own conversation, which the
    // label then states exactly - never to nothing, which would hide the only
    // way back out of a hand-set colour.
    this._resettableColours = Array.from(
      new Set([
        session.session_id,
        ...(hasBranches
          ? [this._lastBranchesCurrent, ...branchList.map(b => b.session_id)]
          : [])
      ])
    ).filter(
      id =>
        !!id &&
        this._colours.isOverride(id) &&
        // Not while its colour is still being written. `isOverride` answers
        // from the last CONFIRMED colour, so a capture replacing an existing
        // one leaves it true - and a release issued in that window is undone,
        // either by the capture landing after it or by the reconcile the
        // release itself runs.
        !this._colours.isPending(id)
    );
    this._rebuildContextMenu(hasBranches);
    this._contextMenu.open(x, y);
  }

  /** Refill both branch submenus for one project. Called only once an open has
   * proved it is still the current one - these are shared widgets, and the
   * menu on screen renders whatever they last held. */
  private _fillBranchSubmenus(branches: IBranch[]): void {
    // The submenu shows only the most recent few inline - fewest clicks for
    // often-used conversations; the full list plus management lives behind the
    // always-present Manage Sessions popup.
    const inline = branches.slice(0, INLINE_BRANCH_LIMIT);
    this._switchSubmenu.clearItems();
    this._switchSubmenu.title.label = `Switch and Manage Sessions (${branches.length})`;
    for (const b of inline) {
      this._switchSubmenu.addItem({
        command: this._cmd('switch-branch'),
        args: { session_id: b.session_id, label: this._branchMenuLabel(b) }
      });
    }
    this._switchSubmenu.addItem({ type: 'separator' });
    this._switchSubmenu.addItem({ command: this._cmd('manage-sessions') });

    // Same conversations, but each launches its own terminal directly.
    this._openBranchSubmenu.clearItems();
    this._openBranchSubmenu.title.label = `Open Branched Conversation (${branches.length})`;
    for (const b of inline) {
      this._openBranchSubmenu.addItem({
        command: this._cmd('open-branch'),
        args: {
          session_id: b.session_id,
          label: this._branchMenuLabel(b),
          // The label reads this to tell an attach from a launch; the
          // provider's own worker capability is tested where it is answered.
          ...(b.bg_id ? { bg: b.bg_id } : {})
        }
      });
    }
    this._openBranchSubmenu.addItem({ type: 'separator' });
    this._openBranchSubmenu.addItem({
      command: this._cmd('manage-sessions')
    });
  }

  private _openManagePopup(): void {
    const session = this._activeSession;
    if (!session) {
      return;
    }
    showManageSessionsPopup({
      branches: this._lastBranches,
      current: this._lastBranchesCurrent || session.session_id,
      projectName: this._lookupName(session),
      deleteToTrash: this._deleteToTrash,
      branchName: b => this._branchDisplayName(b),
      formatTime: ms => this._formatRelativeTime(ms),
      branchBadge: b => this._bgBadgeFor(b),
      openTitle: id => this._openBranchTitle(session, id),
      onSwitch: id => void this._switchBranch(session, id),
      onOpen: id => void this._openSession(session, undefined, id),
      onDelete: ids => this._deleteBranches(session, ids),
      onRefetch: async () => (await this._fetchBranches(session)).branches,
      onSync: branches => {
        this._lastBranches = branches;
      }
    });
  }

  /** Tooltip for one Open button in the Manage Sessions popup. Same rule as the
   * Open Branched Conversation submenu: the button launches a terminal, so it
   * names the mode that launch carries, and a conversation a live worker holds
   * is attached to and carries none. The row's own conversation is not in
   * `_lastBranches`, so it answers from the session. */
  private _openBranchTitle(session: ISession, sessionId: string): string {
    const base = 'Open this conversation in its own terminal';
    const target =
      sessionId === session.session_id
        ? session
        : (this._lastBranches.find(b => b.session_id === sessionId) ?? null);
    const variant = this._resumeVariant(target);
    return variant ? `${base} (${variant.label})` : base;
  }

  /** The live-worker chip for a branch row, when the provider has workers at
   * all. Returning null lets the popup fall back to its fork marker. */
  private _bgBadgeFor(b: IBranch): HTMLElement | null {
    if (!this._descriptor.hasBgAgents || !b.bg_id) {
      return null;
    }
    const bg = document.createElement('span');
    bg.className = 'jp-AiAssistantsPanel-bgBadge';
    bg.textContent = 'bg';
    bg.title = `Background agent: ${b.bg_id}`;
    return bg;
  }

  // ---------------------------------------------------------------- polling

  private _startPolling(): void {
    if (this._pollHandle !== null) {
      return;
    }
    this._pollHandle = window.setInterval(() => {
      // Do not reshuffle rows while the user is in the context menu.
      if (this._contextMenu.isAttached) {
        return;
      }
      // Skip a tick while the previous one is unanswered. The poll fires
      // every 30s and a request is bounded at 60s, so against a hung server
      // this enqueued two for every one that could drain - and the colour
      // store serialises, so the backlog left `isPending` true for its whole
      // length, withholding the release affordance and making a fork await
      // the queue rather than its parent's colour.
      if (this._polling !== null) {
        return;
      }
      this._polling = this._fetch()
        .catch(err => this._showError(err))
        .finally(() => {
          this._polling = null;
        });
    }, POLL_INTERVAL_MS);
  }

  private _stopPolling(): void {
    if (this._pollHandle !== null) {
      window.clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
  }

  private readonly _app: JupyterFrontEnd;
  private readonly _descriptor: IProviderDescriptor;
  private readonly _hooks: IProviderHooks;
  private readonly _serverSettings: ServerConnection.ISettings;
  private _rootDir = '';
  private _deleteToTrash = true;
  private readonly _fileBrowser: IDefaultFileBrowser | null;
  private readonly _colours: ColourStore;
  private readonly _terminals: TerminalManager;
  private readonly _expandedKey: string;
  private readonly _removingPaths: Set<string> = new Set();
  private _bodyEl!: HTMLDivElement;
  private _loadingEl: HTMLElement | null = null;
  private _errorEl: HTMLElement | null = null;
  private _refreshBtn: HTMLButtonElement | null = null;
  private _filterBtn: HTMLButtonElement | null = null;
  private _searchEl: HTMLInputElement | null = null;
  private _searchWrapEl: HTMLDivElement | null = null;
  private _searchClearEl: HTMLButtonElement | null = null;
  private _sessions: ISession[] | null = null;
  private _expanded: Record<SectionKey, boolean>;
  /** Which row carries each section's single tab stop, by encoded path. */
  private _roving: Partial<Record<SectionKey, string>> = {};
  private _commands!: CommandRegistry;
  private _contextMenu!: Menu;
  private _switchSubmenu!: Menu;
  private _openBranchSubmenu!: Menu;
  private _branchSessionMenu!: Menu;
  private _newSessionMenu!: Menu;
  /** Re-writes the `+` button's title. Set once the shell exists. */
  private _renameNewButton: (() => void) | null = null;
  private _lastBranches: IBranch[] = [];
  private _lastBranchesCurrent = '';
  private _colouredTabs = true;
  private _resettableColours: string[] = [];
  /** Bumped per context-menu open, so a slow one that has been superseded
   * knows to touch nothing. */
  private _menuGeneration = 0;
  /** The last branch listing fetched, and the project it belongs to. Read only
   * when this open's own fetch did not arrive in time. */
  private _branchCache: { path: string; data: IBranchesResponse } | null = null;
  private _activeSession: ISession | null = null;
  private _activeRowEl: HTMLElement | null = null;
  private _pollHandle: number | null = null;
  /** The poll's own in-flight tick. Only the poll reads it - an explicit
   * Refresh must always issue, however long the last poll is taking. */
  private _polling: Promise<void> | null = null;
  private _presentationMode: PresentationMode = DEFAULT_PRESENTATION_MODE;
  private _recentLimit: number = DEFAULT_RECENT_LIMIT;
  private _modes: Record<string, boolean | string> = {};
  private _displayNames: Map<string, string> = new Map();
  private _filter = '';
}

export namespace AssistantSessionsPanel {
  export interface IOptions {
    app: JupyterFrontEnd;
    descriptor: IProviderDescriptor;
    hooks?: IProviderHooks;
    /** JupyterLab's server root, for path display and file-browser hand-offs. */
    rootDir: string;
    /** JupyterLab's move-to-trash setting, so dialogs name the right outcome. */
    deleteToTrash?: boolean;
    terminalTracker?: ITerminalTracker | null;
    fileBrowser?: IDefaultFileBrowser | null;
    colourfulTabs?: IColourfulTabs | null;
  }
}
