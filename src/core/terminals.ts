import { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { Dialog, Notification } from '@jupyterlab/apputils';
import { TranslationBundle, nullTranslator } from '@jupyterlab/translation';
import { ServerConnection } from '@jupyterlab/services';
import { ITerminalTracker } from '@jupyterlab/terminal';
import { IColourfulTabs } from '@stellarshenson/jupyterlab-colourful-tab-extension';
import { Widget } from '@lumino/widgets';

import { ColourStore, effectiveColour, sessionForCwds } from './colour';
import { DialogRenderer } from './dialogs';
import { LOG_PREFIX } from './registry';
import { REQUEST_TIMEOUT_MS, requestProvider } from './request';
import {
  IColourChoice,
  ILaunchRequest,
  ILaunchResponse,
  IProviderDescriptor,
  ISession,
  ITabColourEvents,
  ITerminalProbeResponse
} from './types';

/** Colour reconciliation cadence. Matches the row poll so the two collapse
 * into one rhythm while the panel is visible, but it is a separate timer: a
 * terminal running the assistant is tinted whether or not the panel is open. */
const COLOUR_INTERVAL_MS = 30_000;

/** The companion, once both ownership members are known to be there. Painting
 * and ownership are one handle on purpose: this extension tints a tab only
 * where it can also claim it and be told what the user picks on it. */
type TabColourOwner = IColourfulTabs & Required<ITabColourEvents>;

/** Narrow the injected colour token to the ownership API, or null.
 *
 * A run-time probe rather than a type test, because the typings this
 * repository compiles against are the published ones and carry `setColour`
 * alone - see `ITabColourEvents`.
 */
function tabColourOwner(tabs: IColourfulTabs | null): TabColourOwner | null {
  const candidate = tabs as (IColourfulTabs & ITabColourEvents) | null;
  if (
    typeof candidate?.claim !== 'function' ||
    typeof candidate.colourChanged?.connect !== 'function'
  ) {
    return null;
  }
  return candidate as TabColourOwner;
}

/** Said once per page, not once per provider: every assistant panel builds a
 * manager against the same companion, so the latch is what keeps one missing
 * upgrade from printing the same line four times. */
let warnedLegacyCompanion = false;

/** An installed companion too old to carry the ownership API. Loud because the
 * consequence is visible: this extension tints nothing at all against one, so
 * a user whose assistant tabs used to be coloured watches them go plain, and
 * the cause is one upgrade away. */
function warnLegacyCompanion(): void {
  if (warnedLegacyCompanion) {
    return;
  }
  warnedLegacyCompanion = true;
  const message = `jupyterlab_colourful_tab_extension is older than the release that reports tab colour choices and lets another extension own a tab. Terminal tab tinting is off until that extension is upgraded; its own right-click colours keep working as they always did.`;
  console.warn(`${LOG_PREFIX} ${message}`);
  // And said where the user is looking. The symptom is tabs that are simply
  // plain, which reads as a feature that was never on rather than as something
  // to fix, and a console line only reaches someone already suspecting the
  // cause. The retired-extension notice in index.ts pairs its console line
  // with a toast the same way. It does not
  // close on its own, because the condition does not go away on its own.
  Notification.warning(message, { autoClose: false });
}

/** The spinner dialog's header: the title as plain text this module can
 * retitle in place. JupyterLab's own header renders the title through React,
 * which owns that text and writes it back on its first render. */
class SpinnerRenderer extends DialogRenderer {
  createHeader(title: Dialog.Header): Widget {
    const header = new Widget();
    header.addClass('jp-Dialog-header');
    header.node.textContent = String(title);
    // A retitle lands while Hide already has the focus, so the dialog's name
    // is not read again; the header says it instead.
    header.node.setAttribute('aria-live', 'polite');
    return header;
  }
}

const spinnerRenderer = new SpinnerRenderer();

/** Name the action on the spinner dialog: the header the user reads, and the
 * accessible name read out when Hide takes the focus. */
function titleSpinner(dialog: Dialog<unknown>, title: string): void {
  const header = dialog.node.querySelector('.jp-Dialog-header');
  if (header) {
    header.textContent = title;
  }
  dialog.node.setAttribute('aria-label', title);
}

/** Show a modal spinner while an action runs.
 *
 * Hide does not abort the request - it only takes the app-wide scrim away, so
 * a stalled action cannot leave the user staring at a modal with no exit. If
 * the action later succeeds the terminal opens as a tab behind the current
 * one (DEF-PANE-339), unless a later click on the same conversation joined
 * the action - that click's own dialog then decides (DEF-PANE-341). */
function showLaunchSpinner(
  title: string,
  trans: TranslationBundle
): Dialog<unknown> {
  const body = new Widget();
  body.node.className = 'jp-AiAssistantsPanel-launchOverlay';

  const spinner = document.createElement('div');
  spinner.className =
    'jp-aiAssistants-spinner jp-AiAssistantsPanel-launchSpinner';
  body.node.appendChild(spinner);

  const dialog = new Dialog<unknown>({
    title,
    body,
    // `Hide`, not `Cancel`. The button takes the scrim away and nothing else -
    // the request is already on the wire and the terminal will still open, as
    // a tab behind the current one that does not take the keyboard, unless a
    // later click on the same conversation joins the action (DEF-PANE-341). A
    // button named Cancel that does not cancel is worse than no button.
    buttons: [Dialog.okButton({ label: trans.__('Hide') })],
    // Hide is the only exit: the second click of a double-click on the row
    // lands on the backdrop, and that is not a choice to hide (DEF-PANE-340).
    hasClose: false,
    renderer: spinnerRenderer
  });
  // Hide acts on its press, as Enter does in the dialog's own keydown
  // handler, not on the click: a press begun on Hide hides even when the
  // action completes and closes the dialog before the release, which then
  // sends no click (DEF-PANE-348). The second click of that double-click can
  // land on Hide itself, and it is not a choice to hide either
  // (DEF-PANE-342): a multi-click press within 600 ms of the raise is
  // ignored. The mousedown carries the click count; a pointerdown's detail is
  // 0 in Chromium. A later press hides whatever its detail, as a later click
  // confirms the armed Delete (DEF-PANE-338).
  const raisedAt = performance.now();
  dialog.node.addEventListener(
    'mousedown',
    event => {
      if (
        event.button === 0 &&
        (event.target as Element).closest('.jp-Dialog-button') &&
        !(event.detail > 1 && event.timeStamp - raisedAt < 600)
      ) {
        // The focus stays where the close gives it back.
        event.preventDefault();
        dialog.resolve(0);
      }
    },
    true
  );
  // A multi-click press decided on its mousedown, so its click does not reach
  // the dialog's own click listener, which would hide. Registered before
  // `launch()` attaches that listener, so it runs first.
  dialog.node.addEventListener(
    'click',
    event => {
      if (event.detail > 1) {
        event.stopImmediatePropagation();
      }
    },
    true
  );
  // The same for the keyboard: Hide takes the focus, so the repeats of an
  // Enter or Space held on the row land on it, and a repeat is not a press
  // (DEF-PANE-347). A fresh Space presses Hide on the keydown, as Enter does.
  dialog.node.addEventListener(
    'keydown',
    event => {
      if (event.repeat) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else if (
        event.key === ' ' &&
        (event.target as Element).closest('.jp-Dialog-button')
      ) {
        event.preventDefault();
        event.stopPropagation();
        dialog.resolve(0);
      }
    },
    true
  );
  // Scopes the compact layout in base.css to this one dialog.
  dialog.addClass('jp-AiAssistantsPanel-spinnerDialog');
  titleSpinner(dialog, title);
  // `launch()` returns a promise nobody awaits - disposing an open Lumino
  // dialog rejects it with `undefined`, so swallow that here and keep a benign
  // teardown from surfacing as an unhandled rejection.
  dialog.launch().catch(() => undefined);
  return dialog;
}

/** The one spinner dialog, shared by every panel's clicks and launches, and
 * the title of each action it stands for, keyed by the token `beginSpinner`
 * returned. One dialog, retitled, never a second: JupyterLab queues a dialog
 * behind the one on screen, so a second spinner would show only once the first
 * had closed, or never. */
let spinnerDialog: Dialog<unknown> | null = null;
let spinnerSeq = 0;
const spinnerTitles = new Map<number, string>();
/** The newest click that joined an open still running, keyed by the token
 * the open began with (DEF-PANE-341). */
const spinnerJoins = new Map<number, number>();

/** Whether the user hid the dialog of `token`, an action still running. Hide
 * disposes the dialog, and an action begun after it raises a fresh dialog that
 * does not stand for the hidden one (DEF-PANE-339). An open that a later click
 * joined answers for that click's dialog instead (DEF-PANE-341). */
function spinnerHidden(token: number): boolean {
  const newest = spinnerJoins.get(token) ?? token;
  return (
    !spinnerDialog || spinnerDialog.isDisposed || !spinnerTitles.has(newest)
  );
}

/** Show the spinner dialog for one action, or retitle the one already up so it
 * names the newest action. Pass the token to `endSpinner` when the action
 * settles. Hide disposes the dialog for the actions then running: they stay
 * hidden and keep no dialog up, and the next action raises a fresh one. An open
 * that a later click joins follows that click's dialog instead (DEF-PANE-341).
 * The launch inside a click passes the click's token to `launch()`, so a
 * hidden click's launch raises nothing. */
export function beginSpinner(title: string, trans: TranslationBundle): number {
  const token = ++spinnerSeq;
  if (!spinnerDialog || spinnerDialog.isDisposed) {
    spinnerTitles.clear();
    spinnerDialog = showLaunchSpinner(title, trans);
  } else {
    titleSpinner(spinnerDialog, title);
  }
  spinnerTitles.set(token, title);
  return token;
}

/** End one action. The dialog then names the newest action still running, or
 * closes with the last one. */
export function endSpinner(token: number): void {
  spinnerTitles.delete(token);
  if (spinnerTitles.size > 0) {
    if (spinnerDialog && !spinnerDialog.isDisposed) {
      titleSpinner(spinnerDialog, [...spinnerTitles.values()].pop()!);
    }
    return;
  }
  spinnerDialog?.dispose();
  spinnerDialog = null;
}

/** Settles when `promise` settles, or after REQUEST_TIMEOUT_MS - the bound
 * every request of this extension has - whichever comes first. Never rejects. */
function settledOrLate(promise: Promise<unknown>): Promise<void> {
  return new Promise(resolve => {
    const timer = window.setTimeout(resolve, REQUEST_TIMEOUT_MS);
    const done = (): void => {
      window.clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

/** The Launcher tile launches of every assistant, settled when the one
 * clicked last has settled (DEF-PANE-345). */
let tileLaunches: Promise<void> = Promise.resolve();

/**
 * Terminals for one provider: the reuse ladder, the launch call and the tab
 * tint pass.
 *
 * Split out of the panel because none of it is presentation - it is process
 * identity. The panel asks for a conversation and gets a terminal running
 * exactly that conversation, or a fresh one, focused unless the user hid the
 * action's spinner dialog; nothing in here knows about sections, filters or
 * menus.
 */
export class TerminalManager {
  constructor(options: TerminalManager.IOptions) {
    this._app = options.app;
    this._descriptor = options.descriptor;
    this._colours = options.colourStore;
    this._tracker = options.terminalTracker;
    this._serverSettings = options.serverSettings;
    this._trans =
      options.trans ??
      nullTranslator.load('jupyterlab_ai_code_assistants_extension');

    // This narrowing decides whether the extension tints at all. Against a
    // companion with no ownership API it paints nothing: a colour the user
    // picks on a tab cannot be captured there, so the next pass would repaint
    // the conversation's effective colour straight over the pick. Leaving the
    // tabs alone is what makes the companion's own menu behave exactly as it
    // did before this extension was installed.
    this._tabs = tabColourOwner(options.colourfulTabs);
    if (this._tabs) {
      // Subscribed here rather than when the panel is first shown: a colour
      // picked on a tab has to be captured whether or not the user ever opens
      // this assistant's panel, and every panel is constructed at activation.
      this._tabs.colourChanged.connect(this._onColourChanged, this);
    } else if (options.colourfulTabs) {
      warnLegacyCompanion();
    }
  }

  dispose(): void {
    this._disposed = true;
    this.stopColourLoop();
    this._tabs?.colourChanged.disconnect(this._onColourChanged, this);
    this._releaseClaims();
    // A choice waiting for a conversation belongs to a panel that is still
    // running. Kept past dispose it would be filed by nothing and would hold a
    // widget reference for the life of the page.
    this._pendingChoices.clear();
    // Nothing is painted from here on, so the record would only hold widget
    // ids for the life of the page.
    this._lastPainted.clear();
  }

  /**
   * Open a conversation, reusing an open terminal only when that terminal is
   * POSITIVELY running it.
   *
   * Three steps, cheapest first: the per-project microcache, then a walk of
   * every terminal JupyterLab knows about (each probed server-side for the
   * conversation its process actually holds), then a fresh launch. A terminal
   * whose conversation cannot be read is never reused - it may be running a
   * different conversation of the same project, and a session id is globally
   * unique, so an unreadable terminal can never be proven to be the wanted one.
   *
   * Concurrent clicks on the SAME conversation attach to the in-flight
   * promise; a different conversation of the same project launches
   * independently, so branches open side by side.
   *
   * The open in flight then follows the newest click's `spinner`: when that
   * click's dialog closes on its own the terminal takes the keyboard, and when
   * the user hides it the terminal opens behind the current tab - the outcome
   * of a click made after the open had finished (DEF-PANE-341). An open that
   * fails is followed by the joining click's own open, as a click after the
   * failure would be.
   */
  async openSession(
    session: ISession,
    mode: string | undefined,
    sessionId?: string,
    spinner?: number
  ): Promise<void> {
    const wanted = sessionId ?? session.session_id;
    const key = this._key(session.project_path, wanted);
    const inFlight = this._pending.get(key);
    if (inFlight) {
      if (inFlight.spinner !== undefined && spinner !== undefined) {
        spinnerJoins.set(inFlight.spinner, spinner);
      }
      return inFlight.promise.catch(() =>
        this.openSession(session, mode, sessionId, spinner)
      );
    }
    const promise = this._doOpenSession(session, mode, wanted, spinner).finally(
      () => {
        this._pending.delete(key);
        if (spinner !== undefined) {
          spinnerJoins.delete(spinner);
        }
      }
    );
    this._pending.set(key, { promise, spinner });
    return promise;
  }

  /**
   * Run one launch action of this panel - an open, a branch or a new session -
   * after every Launcher tile launch clicked before it (DEF-PANE-345).
   *
   * A tile terminal is opened and shown by JupyterLab's Launcher, outside the
   * spinner dialog, so without this order the terminal shown last, and
   * whether a resume found the tile's terminal or started a second process on
   * the same conversation, depended on which request answered first. The
   * panel's own actions need no order among themselves: the dialog is modal,
   * and an action whose dialog the user hid never takes the tab - an open that
   * a later click joins takes it for that click alone, when that click's own
   * dialog closes on its own (DEF-PANE-341).
   */
  inClickOrder<T>(run: () => Promise<T>): Promise<T> {
    const action = tileLaunches.then(run);
    this._actions.add(action);
    const drop = (): void => {
      this._actions.delete(action);
    };
    action.then(drop, drop);
    return action;
  }

  /** Run one Launcher tile launch after every launch clicked before it: the
   * tile launches of every assistant and this panel's own actions. Each wait
   * ends after REQUEST_TIMEOUT_MS at the latest, so a launch that never
   * settles does not hold every later one (DEF-PANE-345). */
  tileInClickOrder<T>(run: () => Promise<T>): Promise<T> {
    const earlier = [tileLaunches, ...[...this._actions].map(settledOrLate)];
    const launch = Promise.all(earlier).then(run);
    tileLaunches = settledOrLate(launch);
    return launch;
  }

  private async _doOpenSession(
    session: ISession,
    mode: string | undefined,
    wanted: string,
    spinner: number | undefined
  ): Promise<void> {
    // 1. Microcache - the most recent terminal of this project, reused only
    // when it carries the wanted conversation.
    const cached = await this.cached(session.project_path, wanted);
    if (cached) {
      this.focus(cached, spinner);
      return;
    }

    // 2. Walk every live terminal, asking the server what each is running in
    // this project.
    const found = await this.findForSession(wanted, session.project_path);
    if (found) {
      // Tag with the OBSERVED conversation, so a later reuse trusts a
      // confirmed identity rather than a wish.
      this._byProject.set(session.project_path, {
        widget: found.widget,
        sessionId: found.runningId ?? undefined
      });
      this._wireDisposal(session.project_path, found.widget);
      this.focus(found.widget, spinner);
      return;
    }

    // 3. Fresh launch. The server picks the verb (resume, attach, bare) at
    // launch time, because ownership of a conversation can change inside the
    // poll window and only the server can be authoritative about it.
    await this.launch(
      {
        project_path: session.project_path,
        encoded_path: session.encoded_path,
        session_id: wanted,
        mode
      },
      wanted,
      spinner
    );
  }

  /**
   * Launch a terminal for one request and focus it. The returned widget is
   * tagged with `tagSessionId` in the microcache, so a later click on the row
   * that conversation now belongs to reuses this very terminal.
   *
   * `spinner` is the token of the click this launch belongs to. The launch
   * joins that click's spinner instead of beginning its own, so the user sees
   * one dialog from the click to the terminal, and a click the user hid stays
   * hidden and its terminal opens behind the current tab - unless a later
   * click joins the open this launch belongs to and that click's dialog closes
   * on its own (DEF-PANE-341).
   */
  async launch(
    request: ILaunchRequest,
    tagSessionId?: string,
    spinner?: number
  ): Promise<any> {
    const own =
      spinner === undefined
        ? beginSpinner(
            this._trans.__('Opening %1', this._descriptor.label),
            this._trans
          )
        : undefined;
    try {
      const launched = await requestProvider<ILaunchResponse>(
        this._descriptor.id,
        'launch',
        this._serverSettings,
        { method: 'POST', body: JSON.stringify(request) }
      );
      const token = spinner ?? own!;
      const name = launched.terminal_name;
      // `terminal:open` shows the new terminal's tab and moves the focus into
      // it before it returns. When the user has hidden this action's dialog,
      // that focus is stopped before the shell sees it, as JupyterLab's Dialog
      // stops focus that leaves it, so the user's widget stays the current one.
      // The focus goes back to the element it left once the user's tab is
      // shown again (DEF-PANE-339).
      let left = null as HTMLElement | null;
      const keep = (event: FocusEvent): void => {
        const target = event.target as HTMLElement;
        if (
          spinnerHidden(token) &&
          this._liveTerminals().some(
            w => w.content?.session?.name === name && w.node.contains(target)
          )
        ) {
          event.stopPropagation();
          left = event.relatedTarget as HTMLElement | null;
          target.blur();
        }
      };
      document.addEventListener('focus', keep, true);
      let widget: any;
      try {
        widget = await this._app.commands.execute('terminal:open', { name });
      } finally {
        document.removeEventListener('focus', keep, true);
      }
      if (spinnerHidden(token)) {
        this._showCurrentTab();
        left?.focus();
      }
      if (widget?.id) {
        this.remember(request.project_path, widget, tagSessionId);
        this.focus(widget, token);
      }
      return widget ?? null;
    } finally {
      if (own !== undefined) {
        endSpinner(own);
      }
    }
  }

  /** The terminal this manager last opened for `projectPath`, when it is
   * still open, was opened for the conversation `sessionId`, and the server
   * does not read another conversation off its process - which /clear starts
   * in the same process (DEF-PANE-350); else null. */
  async cached(projectPath: string, sessionId: string): Promise<any | null> {
    const cached = this._byProject.get(projectPath);
    if (!cached || cached.widget.isDisposed || cached.sessionId !== sessionId) {
      return null;
    }
    // No id read is the window before the new process is readable, which is
    // what this cache covers (DEF-PANE-345).
    const info = await this.probe(cached.widget);
    if (info?.session_id && info.session_id !== sessionId) {
      if (this._byProject.get(projectPath) === cached) {
        this._byProject.delete(projectPath);
      }
      return null;
    }
    return cached.widget;
  }

  /** Remember `widget` as the newest terminal of `projectPath`, opened for
   * the conversation `sessionId`. A launch is remembered before the server
   * can read the conversation off the new process, so the next open of the
   * same conversation - from a row or a Launcher tile - reuses this terminal
   * instead of starting a second process on it (DEF-PANE-345). */
  remember(projectPath: string, widget: any, sessionId?: string): void {
    this._byProject.set(projectPath, { widget, sessionId });
    this._wireDisposal(projectPath, widget);
  }

  /** Show the current widget's tab again. Opening a terminal selects its tab,
   * so for a hidden action the tab the user was on goes back in front
   * (DEF-PANE-339). */
  private _showCurrentTab(): void {
    const shell = this._app.shell as ILabShell;
    const current = shell.currentWidget;
    const bar = current && shell.getMainAreaTabBar(current);
    if (bar) {
      bar.currentTitle = current.title;
    }
  }

  /**
   * Bring a terminal tab to the front AND hand it keyboard focus, so typing
   * starts without a second click. `activateById` only reveals the tab; the
   * xterm inside does not reliably take DOM focus when the click came from the
   * sidebar, so the focus call is deferred to the next frame - by then the
   * widget is attached and visible.
   *
   * The activation waits for the spinner dialog to close. While the dialog is
   * up it pulls any focus outside it back to Hide, and on closing it returns
   * the focus to the element that had it before - so a terminal activated
   * under it ends up without the keyboard. Closing emits `disposed` before
   * that return, and the activation the tab then receives is processed after
   * it, so the terminal is the last to take the focus.
   *
   * `spinner` is the token of the action that asked. When the user hid that
   * action's dialog the terminal is left where it is - unless a later click
   * joined the action and that click's dialog closes on its own
   * (DEF-PANE-341) - and so is a terminal waiting for the dialog the user then
   * hides (DEF-PANE-339). Without a token no dialog stands for the action - a
   * Launcher tile launch, which runs before every action clicked after it - so
   * the terminal is activated at once, and a dialog up for a later click
   * decides after it (DEF-PANE-345).
   */
  focus(widget: any, spinner?: number): void {
    if (!widget || widget.isDisposed) {
      return;
    }
    if (spinner !== undefined && spinnerHidden(spinner)) {
      return;
    }
    if (spinner !== undefined && spinnerDialog && !spinnerDialog.isDisposed) {
      spinnerDialog.disposed.connect(() => {
        // The dialog closes on its own only with its last action. Closed with
        // an action still running, the user hid it: the terminal is not
        // activated, and its tab, shown behind the dialog, goes back behind
        // the user's tab.
        if (spinnerTitles.size > 0) {
          this._showCurrentTab();
        } else {
          this.focus(widget);
        }
      });
      return;
    }
    this._app.shell.activateById(widget.id);
    requestAnimationFrame(() => {
      try {
        widget.content?.term?.focus?.();
      } catch (_err) {
        // Disposed in the meantime - nothing to focus.
      }
    });
  }

  /** Find an open terminal running exactly this conversation in this project,
   * or null.
   *
   * The server reads the true id from the running process, so a session the
   * user started by hand is recognised too, not only launches that carry an
   * argv id. The terminal must ALSO work in the requested project. An id is
   * not globally unique in the store: Claude re-homes a transcript into a
   * second project under the same id, so an id match alone can name a process
   * running it from another tree, and reusing that one opens nothing in the
   * folder the user clicked (DEF-PANE-319). A process that changed directory
   * WITHIN the project still matches - the probe lists every cwd in its
   * tree. */
  async findForSession(
    wantedSessionId: string | undefined,
    projectPath: string
  ): Promise<{ widget: any; runningId: string | null } | null> {
    if (!this._tracker || !wantedSessionId) {
      return null;
    }
    for (const widget of this._liveTerminals()) {
      const info = await this.probe(widget);
      if (
        info &&
        info.session_id &&
        info.session_id === wantedSessionId &&
        this._runsInProject(info.cwds, projectPath)
      ) {
        return { widget, runningId: info.session_id };
      }
    }
    return null;
  }

  /** Whether any process in the terminal's tree works in `projectPath` or a
   * directory under it. No cwds means nothing to prove the terminal belongs
   * to this project, so it is not reused. */
  private _runsInProject(
    cwds: string[] | undefined,
    projectPath: string
  ): boolean {
    const root = projectPath.replace(/\/+$/, '');
    return (cwds ?? []).some(cwd => {
      const path = cwd.replace(/\/+$/, '');
      return path === root || path.startsWith(`${root}/`);
    });
  }

  /** Ask the server what a terminal is running. Null when the widget has no
   * session name yet, or the probe fails - a terminal can vanish between
   * enumeration and probe, which is a retry, not an error. */
  async probe(widget: any): Promise<ITerminalProbeResponse | null> {
    const name: string | undefined = widget?.content?.session?.name;
    if (typeof name !== 'string' || !name) {
      return null;
    }
    try {
      return await requestProvider<ITerminalProbeResponse>(
        this._descriptor.id,
        `terminal/${encodeURIComponent(name)}`,
        this._serverSettings
      );
    } catch (_err) {
      return null;
    }
  }

  // --------------------------------------------------------------- colours

  /** Turn tinting on or off. Off drops the tint from this provider's terminals
   * at once rather than at the next reload; on re-tints from current state. */
  setColouredTabs(on: boolean): void {
    const enabled = !!on;
    if (this._colouredTabs === enabled) {
      return;
    }
    this._colouredTabs = enabled;
    void (enabled ? this.reconcileColours() : this.clearColours());
  }

  /** Remember the sessions the last poll returned, so the colour loop can run
   * on its own timer without asking the panel for state. */
  setSessions(sessions: ISession[]): void {
    this._sessions = sessions;
  }

  /** Arm the colour loop. Independent of panel visibility: a terminal running
   * the assistant is tinted whether or not the panel is on screen. */
  startColourLoop(): void {
    if (this._disposed || this._colourHandle !== null) {
      return;
    }
    this._colourHandle = window.setTimeout(() => {
      this._colourHandle = null;
      void this.reconcileColours();
    }, COLOUR_INTERVAL_MS);
  }

  stopColourLoop(): void {
    if (this._colourHandle !== null) {
      window.clearTimeout(this._colourHandle);
      this._colourHandle = null;
    }
  }

  /**
   * Re-tint every open terminal of this assistant from the freshest colours,
   * whether this panel launched it or the user opened it themselves.
   *
   * Each terminal's conversation is re-resolved on every pass rather than
   * taken from the launch cache, which pins the launch-time conversation and
   * goes stale on an in-place switch.
   *
   * It touches this extension's own store and nothing else - no browser
   * storage, no other extension's records, and that must stay true. The colour
   * the user picks on a tab arrives as a signal instead (`_onColourChanged`);
   * reading it back out of the companion's storage is what made a recycled
   * terminal name hand a dead terminal's colour to a live conversation,
   * permanently, at the top of the ladder. The only write this pass makes is a
   * choice that signal already delivered, whose conversation was unreadable at
   * the time - see `_pendingChoices`.
   */
  async reconcileColours(): Promise<void> {
    if (!this._colouredTabs) {
      // No rearm: `setColouredTabs(true)` calls straight back in here.
      return;
    }
    // This pass's place in the order. A pass awaiting a probe can be overtaken
    // by a later one, and only the pass that is still current may sweep or
    // paint: an overtaken pass would release a claim the newer one legitimately
    // took, and repaint over what it drew.
    const generation = ++this._pass;
    try {
      // Ids recognised as this assistant's on THIS pass. Every other claim is
      // released at the end of it - see `_releaseLapsedClaims`.
      const recognised = new Set<string>();
      // Ids the server positively answered are NOT this assistant's on this
      // pass. Separate from "not in `recognised`", which also holds for a
      // terminal whose probe simply failed.
      const disowned = new Set<string>();
      await this._eachAssistantTerminal(
        async (widget, info) => {
          if (
            !this._colouredTabs ||
            this._disposed ||
            this._pass !== generation
          ) {
            // `clearColours()`, `dispose()` or a NEWER pass landed while this one
            // was in flight. The first two release every claim and are done by
            // the time this runs, so claiming or painting now would put back
            // exactly what they took away, with nothing left to undo it; the
            // third owns these tabs from here on.
            return;
          }
          // Recognition is what earns the claim, so it is taken here rather than
          // at launch: a terminal the user started by hand is this assistant's
          // too, and only the probe can say so.
          recognised.add(widget.id);
          this._claimTab(widget);

          if (this._pendingChoices.has(widget.id)) {
            // The conversation the running PROCESS holds, never the folder
            // fallback below: a project holds many conversations, and filing the
            // user's colour under the wrong one recolours a conversation they
            // never touched.
            if (!info.session_id) {
              // Still unreadable, so the choice cannot be filed yet - and this
              // tab must not be painted either. Every colour available to paint
              // is the conversation's previous one, which is what the pick was
              // meant to replace, and the pending record is what says the pick
              // has not been honoured.
              return;
            }
            const choice = this._pendingChoices.get(widget.id) ?? null;
            // Dropped on the attempt, not on success. A refused write is the
            // store being unwritable rather than the conversation being
            // unreadable, and retrying it on every pass would warn every 30
            // seconds for the rest of the session.
            this._pendingChoices.delete(widget.id);
            const filed = await this._fileChoice(info.session_id, choice);
            if (
              !filed ||
              !this._colouredTabs ||
              this._disposed ||
              this._pass !== generation
            ) {
              return;
            }
          }
          const sessionId =
            info.session_id ??
            sessionForCwds(info.cwds ?? [], this._sessions)?.session_id ??
            null;

          // The server releases a stored colour that a later colour command of
          // the assistant overtook (DEF-COLO-306), and the cache would go on
          // painting it from the top of the ladder: only the panel's poll
          // reloads it, and that poll stops while the panel is hidden. A probe
          // naming this conversation answers its effective colour with every
          // entry the server still holds on top, so a cached entry the probe
          // disagrees with is no longer the server's - reload before painting.
          // The reload queues behind every write of the store (DEF-30), so a
          // pick confirmed after the probe answered survives it.
          const cached = this._colours.get(sessionId);
          if (
            cached !== null &&
            info.session_id === sessionId &&
            info.colour !== undefined &&
            info.colour !== cached
          ) {
            await this._colours.load();
            if (
              !this._colouredTabs ||
              this._disposed ||
              this._pass !== generation
            ) {
              return;
            }
          }

          const native =
            info.colour ??
            (sessionId
              ? (this._sessions.find(s => s.session_id === sessionId)?.colour ??
                null)
              : null);

          // The probe follows the pidfile, so an in-place `/clear` answers the
          // SAME terminal with a NEW conversation id. The replacement continues
          // the conversation it replaced and takes over the effective colour
          // that one was wearing - a pick made on the tab or a colour the
          // assistant chose. A stored colour or an assistant-chosen colour on
          // the new conversation is its own answer, though: only a bare new id
          // is filled in, so the old colour never overwrites it.
          let colour = effectiveColour(
            sessionId,
            this._descriptor.colourSource,
            this._colours.get(sessionId),
            native
          );
          if (sessionId) {
            const last = this._lastPainted.get(widget.id);
            if (
              last &&
              last.sessionId !== sessionId &&
              last.colour !== null &&
              this._colours.get(sessionId) === null &&
              native === null
            ) {
              await this._colours.inherit(sessionId, last.colour);
              if (
                !this._colouredTabs ||
                this._disposed ||
                this._pass !== generation
              ) {
                // Colouring went off, the panel went away or a newer pass took
                // over while the write was queued. That pass paints the tabs.
                return;
              }
              colour = this._colours.get(sessionId) ?? last.colour;
            }
            this._lastPainted.set(widget.id, { sessionId, colour });
          }
          this._applyColour(widget, colour);
        },
        widget => disowned.add(widget.id)
      );
      if (this._pass === generation) {
        // Skipped by an overtaken pass: its view of what is recognised and what
        // is open is the older one, and acting on it would undo the newer
        // pass's work.
        this._releaseLapsedClaims(recognised);
        this._dropStalePending(disowned);
      }
    } catch (err) {
      // Tinting reaches into another extension and a probe per terminal, so
      // this pass has several ways to throw. Swallowed so that every caller
      // can await it plainly rather than each carrying its own rejection
      // discipline. Logged rather than silent - a failed pass just stops
      // applying tints, which is indistinguishable from a panel that has no
      // colours to draw.
      console.warn(
        `${LOG_PREFIX}[${this._descriptor.id}] tab colour pass failed.`,
        err
      );
    } finally {
      // Always rearm, even after a failed pass - one bad probe must not end
      // tinting for the rest of the session.
      this.startColourLoop();
    }
  }

  /** Drop the tint from this assistant's terminals. Only its own terminals are
   * touched, so a tint the user set by hand on another tab survives.
   *
   * Swallows like `reconcileColours`, and for the same reason: both reach into
   * another extension, both are called as `void`, and turning tab colouring
   * off must not spill an unhandled rejection. */
  async clearColours(): Promise<void> {
    // Ownership goes with the tint. With colouring off `_captureColour` files
    // nothing, so a claim held here would leave a colour picked on that tab
    // persisted by nobody.
    this._releaseClaims();
    // And so does a choice still waiting for its conversation. Filing it later
    // would put a colour on the top rung of a ladder this extension is not
    // drawing, which is the same thing `_captureColour` refuses to do while
    // colouring is off.
    this._pendingChoices.clear();
    // Every terminal this manager still sees is about to be painted null, so
    // no recorded paint describes what is on screen any more - and a `/clear`
    // that happened while colouring was off must not be inherited from.
    this._lastPainted.clear();
    const generation = ++this._pass;
    try {
      await this._eachAssistantTerminal(async widget => {
        if (this._pass !== generation) {
          // A `setColouredTabs(true)` overtook this clear and has already
          // painted. Stripping now would take that tint straight off again,
          // and nothing would put it back until the next pass.
          return;
        }
        this._applyColour(widget, null);
      });
    } catch (_err) {
      // Nothing to retry - the setting is off either way.
    }
  }

  /** The user picked a colour on a tab, or cleared one.
   *
   * The slot itself stays synchronous - Lumino ignores what a slot returns, so
   * an async slot's rejection would surface as an unhandled one.
   */
  private _onColourChanged(_sender: unknown, choice: IColourChoice): void {
    void this._captureColour(choice);
  }

  /** File one choice against the conversation the coloured terminal is
   * actually running.
   *
   * Only a terminal this provider owns, and only one whose conversation the
   * server READ from the running process. A widget whose conversation cannot
   * be read is never filed against one guessed from its folder: a project has
   * many conversations, and filing the user's colour under the wrong one
   * recolours a conversation they never touched. That choice waits instead,
   * but only where the probe named the terminal - see `_pendingChoices`.
   */
  private async _captureColour(choice: IColourChoice): Promise<void> {
    if (!this._colouredTabs) {
      // Nothing here is claimed while colouring is off, so the companion owns
      // that tab and keeps the choice itself. Taking a copy would put a colour
      // on the top rung of a ladder this extension is not drawing, to surface
      // the day the setting is turned back on.
      return;
    }
    try {
      const widget = this._liveTerminals().find(w => w.id === choice.widgetId);
      if (!widget) {
        return;
      }
      const info = await this.probe(widget);
      if (!this._colouredTabs || this._disposed) {
        // Switched off, or the panel disposed, while the probe was in flight.
        // The check on entry cannot cover this: what is written from here is
        // hand-set, the top rung of a ladder that is no longer being drawn, and
        // it would surface the day the setting is turned back on.
        return;
      }
      if (!info || !info.running) {
        // Not this assistant's terminal, or a probe that could not be read at
        // all. Neither is evidence of ownership, so neither is remembered: a
        // failed probe says only that the server did not answer, and a choice
        // held on that basis is filed against whatever conversation the
        // terminal later turns out to run.
        if (!info) {
          // Said, not swallowed. The companion has already deleted whatever it
          // held for this tab and persisted nothing new, so on a probe that did
          // not answer the pick now exists only as a class Lumino rebuilds away
          // at the next tab switch - the user watches their colour appear and
          // then vanish. Every other losing path in this file speaks; this one
          // is the same kind of loss.
          console.warn(
            `${LOG_PREFIX}[${this._descriptor.id}] tab colour could not be attributed to a conversation - the terminal probe did not answer, so the choice was not kept.`
          );
        } else {
          // The server ANSWERED, and the answer is that this terminal is no
          // longer running this assistant. That ends the conversation any held
          // choice was picked under, so the hold is released here rather than a
          // pass later: the assistant coming back in this same terminal starts a
          // NEW conversation, and the widget id does not change, so a choice
          // that survives the gap is filed as hand-set against a conversation
          // the user picked no colour for. `_dropStalePending` already acts on
          // exactly this evidence - this is the same rule at the moment the
          // evidence arrives.
          this._pendingChoices.delete(choice.widgetId);
        }
        return;
      }
      if (!info.session_id) {
        // The terminal IS this assistant's - the probe said so - and its
        // conversation is not readable yet: the CLI has not written it. The
        // signal fires ONCE, so dropping the choice here loses it, and the next
        // pass then paints the conversation's effective colour straight over
        // the pick. Remembered instead and re-attempted by that same pass,
        // which probes every terminal anyway. Keyed by widget id, so a later
        // choice on this tab replaces this one - the user changing their mind.
        this._pendingChoices.set(choice.widgetId, choice.colourId);
        // And paint the PICK, which nothing else now holds. The companion has
        // deleted whatever it stored for this claimed tab, and the store has not
        // got the choice yet, so without this the colour lives only as a class
        // on the tab element that Lumino rebuilds away at the next tab switch -
        // the user's colour appears, vanishes, and returns by itself when the
        // pass finally files it. Painting here writes the widget's Lumino title
        // instead, which rides re-renders. This is not the ladder being painted
        // over the pick, which the pass below still refuses to do: it is the
        // pick itself, and it is the only colour that is correct to show.
        this._applyColour(widget, choice.colourId);
        return;
      }
      // An earlier pick on this same tab, held because its conversation was
      // unreadable then, is superseded the moment a newer one can be filed.
      // Dropped BEFORE the write, not after it: the reconcile two lines below
      // replays whatever is still pending, so a choice left here is filed
      // straight back over the one about to be written - the user's older pick
      // replacing their newer one, which is this design's own defect one layer
      // up. Dropped on a refused write too, for the same reason: the pick that
      // superseded it was made either way.
      this._pendingChoices.delete(choice.widgetId);
      if (!(await this._fileChoice(info.session_id, choice.colourId))) {
        return;
      }
      await this.reconcileColours();
    } catch (err) {
      console.warn(
        `${LOG_PREFIX}[${this._descriptor.id}] tab colour capture failed.`,
        err
      );
    }
  }

  /** Write one choice into this extension's own store - a colour for a pick, a
   * forget for a clear - and answer whether the store now holds it.
   *
   * Nothing is painted for a refused write, at either call site. The tab is
   * claimed, so the companion holds no record of this choice and there is
   * nothing in the store either - every colour this extension could paint is
   * the conversation's PREVIOUS one, which is what the pick was meant to
   * replace. What the user sees instead is the class the companion's menu put
   * on the tab element, and that survives only until the next tab switch:
   * Lumino rebuilds a tab's class attribute from the widget title whenever the
   * current tab changes, and the title still carries that previous colour. So
   * the choice is lost either way - the warning is what makes it something
   * other than silent. */
  private async _fileChoice(
    sessionId: string,
    colourId: string | null
  ): Promise<boolean> {
    const stored = colourId
      ? await this._colours.set(sessionId, colourId)
      : await this._colours.forget([sessionId]);
    if (!stored) {
      console.warn(
        `${LOG_PREFIX}[${this._descriptor.id}] tab colour choice was not stored; the conversation keeps its previous colour.`
      );
    }
    return stored;
  }

  /** Tell the companion this tab's colour is ours to persist.
   *
   * Once per terminal, not once per pass - the pass runs every 30 seconds and
   * each claim is a disposable the companion has to hold. A widget id is a
   * safe key for that: JupyterLab mints one uuid per widget (`id-<uuid4>`,
   * verified against 4.6.3 on 2026-09-04) and never hands it to a second
   * widget, so a claim held under an id belongs to the widget still wearing
   * it. Terminal NAMES are what terminado recycles - which is why the
   * companion fingerprints what it persists, and why nothing here keys on a
   * name.
   */
  private _claimTab(widget: any): void {
    const tabs = this._tabs;
    const id: string | undefined = widget?.id;
    if (!tabs || !id || this._claims.has(id)) {
      return;
    }
    this._claims.set(id, tabs.claim(widget));
  }

  /** Give up every claim this pass did not renew.
   *
   * A claim says "this extension draws this tab and records what you pick on
   * it", and that stops being true the moment the terminal stops probing as
   * this assistant's - it exited, another assistant took the pty, or the
   * widget is gone from the tracker altogether. Holding on would leave a
   * colour picked on that tab persisted by nobody, and the map growing by one
   * entry per closed terminal for the life of the page.
   *
   * A terminal whose probe merely failed is released too, since an unreadable
   * terminal is not evidence of ownership. The next pass that reads it claims
   * it again, and re-claiming costs nothing visible: a claim suppresses the
   * companion's persistence and narrows its repaint to a fingerprint-verified
   * entry, deleting nothing it stored before, and the next paint puts this
   * conversation's colour back. */
  private _releaseLapsedClaims(recognised: Set<string>): void {
    this._claims.forEach((claim, id) => {
      if (!recognised.has(id)) {
        claim.dispose();
        this._claims.delete(id);
      }
    });
  }

  private _releaseClaims(): void {
    this._claims.forEach(claim => claim.dispose());
    this._claims.clear();
  }

  /** Forget the choices whose premise no longer holds.
   *
   * A choice is held on one answer only - this assistant's terminal, its
   * conversation not readable yet - and it stops being a choice about anything
   * the moment either half of that stops being true.
   *
   * The terminal CLOSED. A pending choice is about one tab and must not outlive
   * it. A widget id is never handed to a second widget, so the record could
   * never be filed again - what it would do is hold that widget's id, one entry
   * per closed terminal, for the life of the page.
   *
   * The terminal is no longer THIS ASSISTANT'S, per an answer the server
   * actually gave. The conversation the pick was made under has ended, and the
   * assistant coming back in the same terminal starts a NEW one - so a choice
   * kept across that gap is filed against a conversation the user never picked
   * a colour for, as hand-set, at the top of the ladder. A probe that failed is
   * deliberately not evidence here: it says only that the server did not
   * answer, and discarding the pick on that basis loses a colour the user chose
   * seconds ago. */
  private _dropStalePending(disowned: Set<string>): void {
    if (this._pendingChoices.size === 0) {
      return;
    }
    const open = new Set(this._liveTerminals().map(widget => widget.id));
    this._pendingChoices.forEach((_choice, id) => {
      if (!open.has(id) || disowned.has(id)) {
        this._pendingChoices.delete(id);
      }
    });
  }

  private _applyColour(widget: any, colourId: string | null): void {
    if (!this._tabs || !widget || widget.isDisposed) {
      return;
    }
    this._tabs.setColour(widget, colourId);
  }

  private async _eachAssistantTerminal(
    apply: (widget: any, info: ITerminalProbeResponse) => void | Promise<void>,
    disowned?: (widget: any) => void
  ): Promise<void> {
    // No ownership API, no tinting - see the constructor. The guard sits here
    // so that every path through the tint (the pass, the clear, the capture's
    // repaint) stops at the same place.
    if (!this._tabs || !this._tracker) {
      return;
    }
    const widgets = this._liveTerminals();
    await Promise.all(
      widgets.map(async widget => {
        const info = await this.probe(widget);
        if (widget.isDisposed || !info) {
          // A probe that did not answer says nothing about whose terminal this
          // is, so nothing is concluded from it - neither by the caller's
          // `apply` nor by its `disowned`.
          return;
        }
        if (!info.running) {
          // The server answered, and the answer is that this assistant is not
          // what the terminal runs. That is the positive evidence `disowned`
          // exists for, and it is why the two cases above cannot share this
          // branch.
          disowned?.(widget);
          return;
        }
        await apply(widget, info);
      })
    );
  }

  private _liveTerminals(): any[] {
    const widgets: any[] = [];
    this._tracker?.forEach((widget: any) => {
      if (widget && !widget.isDisposed) {
        widgets.push(widget);
      }
    });
    return widgets;
  }

  private _wireDisposal(projectPath: string, widget: any): void {
    if (!widget?.disposed?.connect) {
      return;
    }
    widget.disposed.connect(() => {
      if (this._byProject.get(projectPath)?.widget === widget) {
        this._byProject.delete(projectPath);
      }
    });
  }

  private _key(projectPath: string, sessionId?: string): string {
    return `${projectPath}\n${sessionId ?? ''}`;
  }

  private readonly _app: JupyterFrontEnd;
  private readonly _descriptor: IProviderDescriptor;
  private readonly _trans: TranslationBundle;
  private readonly _colours: ColourStore;
  private readonly _tracker: ITerminalTracker | null;
  /** The injected colour token narrowed to its ownership API, or null when the
   * companion is absent or too old to carry it. The only handle on the
   * companion this class has: with no ownership there is no painting either. */
  private readonly _tabs: TabColourOwner | null;
  private readonly _serverSettings: ServerConnection.ISettings;
  // One claim per terminal, keyed by widget id - see `_claimTab` for why that
  // id identifies exactly one widget.
  private readonly _claims: Map<string, { dispose(): void }> = new Map();
  // Choices made on a terminal that probed as this provider's while its
  // conversation was not yet readable, keyed by the same widget id and holding
  // the colour id chosen (null for a clear). A probe that FAILED records
  // nothing - it says nothing about whose terminal it is, and a choice held on
  // that basis lands on a conversation the user never coloured. The signal
  // fires once, so this map is the only thing keeping such a pick alive until a
  // pass can read the conversation and file it - and while an entry stands, its
  // terminal is not painted, because painting is what destroys the pick.
  private readonly _pendingChoices: Map<string, string | null> = new Map();
  // The conversation each terminal was last PAINTED from, and the effective
  // colour it was painted. The probe follows the pidfile, so `/clear` answers
  // the same widget with a new conversation id; a difference against this
  // record is what tells an in-place replacement from a terminal that simply
  // started later, and is the colour the replacement inherits. Pruned by
  // `clearColours` and `dispose` so a tab that is no longer drawn leaves no
  // entry behind.
  private readonly _lastPainted: Map<
    string,
    { sessionId: string; colour: string | null }
  > = new Map();
  // Most recent terminal per project, tagged with the conversation it runs so
  // reuse can tell a project's branches apart.
  private readonly _byProject: Map<
    string,
    { widget: any; sessionId?: string }
  > = new Map();
  // In-flight launches keyed per CONVERSATION, so two branches of one project
  // open independently and concurrently, each with the spinner token it began
  // with.
  private readonly _pending: Map<
    string,
    { promise: Promise<void>; spinner?: number }
  > = new Map();
  // This panel's launch actions still running, which a tile launch clicked
  // after them waits for - see `inClickOrder`.
  private readonly _actions: Set<Promise<unknown>> = new Set();
  private _sessions: ISession[] = [];
  private _colouredTabs = true;
  private _colourHandle: number | null = null;
  // Order of the colour passes, `reconcileColours` and `clearColours` alike.
  // A pass whose generation is no longer the current one has been overtaken and
  // neither sweeps nor paints - a counter, not a timer.
  private _pass = 0;
  private _disposed = false;
}

export namespace TerminalManager {
  export interface IOptions {
    app: JupyterFrontEnd;
    descriptor: IProviderDescriptor;
    colourStore: ColourStore;
    terminalTracker: ITerminalTracker | null;
    colourfulTabs: IColourfulTabs | null;
    serverSettings: ServerConnection.ISettings;
    /** Bundle every user-visible string passes through. Optional so a
     * caller that does not translate keeps working - the null bundle
     * returns each string unchanged. */
    trans?: TranslationBundle;
  }
}
