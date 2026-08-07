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
import { closeIcon, folderIcon, terminalIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { UUID } from '@lumino/coreutils';
import { Message } from '@lumino/messaging';
import { Menu, Widget } from '@lumino/widgets';

import { ColourStore } from './colour';
import {
  addIcon,
  branchIcon,
  filterIcon,
  providerIcon,
  refreshIcon,
  removeIcon,
  starFilledIcon,
  switchIcon,
  warningIcon
} from './icons';
import { resolveLaunchMode } from './modes';
import { showManageSessionsPopup } from './popup';
import { LOG_PREFIX } from './registry';
import { isResponseStatus, requestProvider, withQuery } from './request';
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
// After a fork is requested, watch for its lazily-written store entry at this
// faster cadence (bounded) so a new branch surfaces in seconds.
const BRANCH_WATCH_INTERVAL_MS = 2_000;
const BRANCH_WATCH_MAX_ATTEMPTS = 90; // ~3 minutes
const DEFAULT_RECENT_LIMIT = 10;
/** Conversations listed inline in a branch submenu before the popup takes over. */
const INLINE_BRANCH_LIMIT = 5;

type SectionKey = 'favourites' | 'recent' | 'all';

export type PresentationMode = 'name' | 'path';

const DEFAULT_PRESENTATION_MODE: PresentationMode = 'name';

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

/** Whether the user asked the platform for reduced motion. */
function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  );
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
    this._rootDir = (options.rootDir || '').replace(/\/+$/, '');
    this._deleteToTrash = options.deleteToTrash !== false;
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
    this._setLoading(true);
    this._setRefreshSpinning(true);
    // `_fetch` is filesystem-fast, so without a floor the spinner shows for a
    // single frame and reads as "nothing happened". Hold it ~500 ms so the
    // click visibly registers as a full re-poll - except under reduced motion,
    // where an artificially prolonged spin is exactly what the preference asks
    // us not to draw.
    const minSpin = prefersReducedMotion()
      ? Promise.resolve()
      : new Promise<void>(resolve => window.setTimeout(resolve, 500));
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
    const clamped = Math.max(1, Math.min(100, Math.floor(n)));
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
  }

  setColouredTabs(on: boolean): void {
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
    newBtn.title = `New ${this._descriptor.label} session in the current folder`;
    addIcon.element({ container: newBtn });
    newBtn.addEventListener('click', () => {
      // Drop the menu just below the button, left-aligned with it.
      const rect = newBtn.getBoundingClientRect();
      this._newSessionMenu.open(rect.left, rect.bottom);
    });
    header.appendChild(newBtn);

    const filterBtn = document.createElement('button');
    filterBtn.className = 'jp-AiAssistantsPanel-iconButton';
    filterBtn.title = 'Filter sessions';
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

  private _showError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this._logError(message);
    this._setInlineError(`Could not reach the server - retrying. ${message}`);
  }

  /** A one-shot action failed. Nothing retries it, so the copy names what did
   * not happen instead of promising a retry the poll loop alone performs. */
  private _showActionError(copy: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this._logError(message);
    this._setInlineError(`${copy} ${message}`);
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
      this._showActionError('Could not toggle favourite - try again.', err);
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
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Remove' })]
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
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Remove' })]
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
    // Hide the Close button while work is in progress; restore it once the
    // outcome is shown so the user can dismiss the popup.
    const footer = dialog.node.querySelector(
      '.jp-Dialog-footer'
    ) as HTMLElement | null;
    if (footer) {
      footer.style.display = 'none';
    }
    void dialog.launch();

    try {
      // The extras ARE the branch list - the current conversation is not in
      // it - so cleaning up is deleting exactly those ids.
      const listed = await this._fetchBranches(session);
      const ids = listed.branches.map(b => b.session_id);
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
      this._showError(err);
    } finally {
      if (footer) {
        footer.style.display = '';
      }
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
        this._showError(err);
      }
    } finally {
      // Reuse or fresh launch, either way the picture changed. Pull fresh
      // state; a poll tick retries if this one fails.
      void this._fetch().catch(() => undefined);
    }
  }

  /** Absolute path of the file browser's current folder; the server root when
   * no file browser is available. */
  private _currentFolder(): string {
    const rel = (this._fileBrowser?.model?.path ?? '').replace(/^\/+/, '');
    return rel ? `${this._rootDir}/${rel}` : this._rootDir;
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
      this._showError(err);
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
    if (this._descriptor.namingStrategy !== 'none') {
      const named = await InputDialog.getText({
        title: 'Branch Session',
        label: 'Name for the new session',
        placeholder: this._lookupName(session)
      });
      if (!named.button.accept || !named.value || !named.value.trim()) {
        return;
      }
      name = named.value.trim();
    }

    if (this._descriptor.forkStrategy === 'server-copy') {
      await this._branchByServerCopy(session, name, force, parentColour);
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
    await this._inheritColour(parentColour, forkId);
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
      this._showError(err);
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
    force: string | undefined,
    parentColour: string | null
  ): Promise<void> {
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
      await this._inheritColour(parentColour, fork.session_id);
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
        this._showError(err);
      }
      return;
    }
    await this._fetch().catch(() => undefined);
  }

  /** Copy the parent's tint onto a fresh branch, unless the assistant owns
   * conversation colours itself: that store refuses every write (the server
   * answers 400), so the call would be one guaranteed-failing request per fork
   * plus a tint that shows until the next reconcile drops it again. */
  private async _inheritColour(
    parentColour: string | null,
    childId: string
  ): Promise<void> {
    if (this._descriptor.colourSource === 'native') {
      return;
    }
    await this._colours.inherit(parentColour, childId);
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
          await this._inheritColour(parentColour, fresh.session_id);
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
          'That conversation cannot become current - its recorded folder does not match the project.',
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

    if (favourites.length > 0) {
      this._renderSection('favourites', favourites);
    }
    this._renderSection('recent', recent);
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
        // A filter that hides everything and a genuinely empty section are
        // different states, and only the first one has a way out.
        empty.textContent = this._filter.trim()
          ? 'No matches.'
          : key === 'favourites'
            ? 'No favorites yet.'
            : 'Empty.';
        list.appendChild(empty);
      } else {
        for (const item of items) {
          list.appendChild(this._renderRow(item, key));
        }
      }
      section.appendChild(list);
    }

    this._bodyEl.appendChild(section);
  }

  private _renderRow(
    session: ISession,
    sectionKey: SectionKey
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'jp-AiAssistantsPanel-row';
    row.title = this._buildRowTooltip(session);
    // The row IS the primary control - without these it is reachable by mouse
    // only, and so is the context menu that carries every other action.
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

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
    name.textContent = this._lookupName(session);
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
      const star = document.createElement('span');
      star.className = 'jp-AiAssistantsPanel-favStar';
      star.title = 'Favorite';
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
    row.addEventListener('keydown', e => {
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
    lines.push(
      ...(this._hooks.tooltipLines?.({
        session: s,
        descriptor: this._descriptor
      }) ?? [])
    );
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
    if (absolute.startsWith(this._rootDir + '/')) {
      return absolute.slice(this._rootDir.length + 1);
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

  /** Boolean launch modes that produce a menu variant - the assistant's own
   * skip-approval switch, under the assistant's own name. */
  private get _variantModes(): ILaunchMode[] {
    return this._descriptor.launchModes.filter(
      m => m.kind === 'boolean' && !!m.menuLabel
    );
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
      label: () => this._hooks.resumeLabel?.(active()) ?? 'Resume',
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
        icon: warningIcon,
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
        label: `New ${this._descriptor.label} Session (${mode.menuLabel})`,
        icon: warningIcon,
        execute: () => void this._newSession(mode.id)
      });
      this._commands.addCommand(this._cmd(`branch-session-${mode.id}`), {
        label: mode.menuLabel as string,
        icon: warningIcon,
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
          Notification.warning(
            'Folder is outside the JupyterLab root - cannot open a terminal there.',
            { autoClose: 4000 }
          );
          return;
        }
        this._app.commands
          .execute('terminal:create-new', { cwd: rel })
          .catch(err => this._showError(err));
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
          Notification.warning(
            'Folder is outside the JupyterLab root - the file browser cannot show it.',
            { autoClose: 4000 }
          );
          return;
        }
        this._app.commands
          .execute('filebrowser:go-to-path', { path: rel })
          .catch(err => this._showError(err));
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

    this._commands.addCommand(this._cmd('cleanup-parallel'), {
      label: () =>
        `Clean Up Parallel Sessions (${active()?.extra_sessions ?? 0})`,
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
      label: args => String(args.label ?? ''),
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
      label: 'Normal',
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
      label: `New ${this._descriptor.label} Session`,
      execute: () => void this._newSession()
    });

    this._buildMenus();
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
    const menu = new Menu({ commands: this._commands });
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
    this._contextMenu.addItem({
      type: 'submenu',
      submenu: this._branchSessionMenu
    });
    add('cleanup-parallel');
    add('remove');
  }

  /** Open the row context menu, populating the branch submenus first when the
   * project holds more than one conversation. A fetch failure opens the menu
   * without them rather than not at all. */
  private async _openContextMenu(
    session: ISession,
    x: number,
    y: number
  ): Promise<void> {
    let hasBranches = false;
    if (session.extra_sessions > 0) {
      try {
        const data = await this._fetchBranches(session);
        this._lastBranches = data.branches;
        this._lastBranchesCurrent = data.current;
        const inline = data.branches.slice(0, INLINE_BRANCH_LIMIT);

        // The submenu shows only the most recent few inline - fewest clicks
        // for often-used conversations; the full list plus management lives
        // behind the always-present Manage Sessions popup.
        this._switchSubmenu.clearItems();
        this._switchSubmenu.title.label = `Switch and Manage Sessions (${data.branches.length})`;
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
        this._openBranchSubmenu.title.label = `Open Branched Conversation (${data.branches.length})`;
        for (const b of inline) {
          this._openBranchSubmenu.addItem({
            command: this._cmd('open-branch'),
            args: { session_id: b.session_id, label: this._branchMenuLabel(b) }
          });
        }
        this._openBranchSubmenu.addItem({ type: 'separator' });
        this._openBranchSubmenu.addItem({
          command: this._cmd('manage-sessions')
        });
        hasBranches = data.branches.length > 0;
      } catch {
        hasBranches = false;
      }
    }
    this._rebuildContextMenu(hasBranches);
    this._contextMenu.open(x, y);
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
      branchBadge: this._hooks.branchBadge
        ? b => this._hooks.branchBadge!(b)
        : b => this._bgBadgeFor(b),
      onSwitch: id => void this._switchBranch(session, id),
      onOpen: id => void this._openSession(session, undefined, id),
      onDelete: ids => this._deleteBranches(session, ids),
      onRefetch: async () => (await this._fetchBranches(session)).branches,
      onSync: branches => {
        this._lastBranches = branches;
      }
    });
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
      this._fetch().catch(err => this._showError(err));
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
  private readonly _rootDir: string;
  private readonly _deleteToTrash: boolean;
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
  private _commands!: CommandRegistry;
  private _contextMenu!: Menu;
  private _switchSubmenu!: Menu;
  private _openBranchSubmenu!: Menu;
  private _branchSessionMenu!: Menu;
  private _newSessionMenu!: Menu;
  private _lastBranches: IBranch[] = [];
  private _lastBranchesCurrent = '';
  private _activeSession: ISession | null = null;
  private _activeRowEl: HTMLElement | null = null;
  private _pollHandle: number | null = null;
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
