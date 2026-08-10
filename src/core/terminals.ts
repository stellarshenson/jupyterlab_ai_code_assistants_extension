import { JupyterFrontEnd } from '@jupyterlab/application';
import { Dialog } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { ITerminalTracker } from '@jupyterlab/terminal';
import { IColourfulTabs } from 'jupyterlab_colourful_tab_extension';
import { Widget } from '@lumino/widgets';

import {
  ColourStore,
  effectiveColour,
  readUserSetTabColour,
  sessionForCwds
} from './colour';
import { LOG_PREFIX } from './registry';
import { requestProvider } from './request';
import {
  ILaunchRequest,
  ILaunchResponse,
  IProviderDescriptor,
  ISession,
  ITerminalProbeResponse
} from './types';

/** Colour reconciliation cadence. Matches the row poll so the two collapse
 * into one rhythm while the panel is visible, but it is a separate timer: a
 * terminal running the assistant is tinted whether or not the panel is open. */
const COLOUR_INTERVAL_MS = 30_000;

/** Show a modal spinner while a terminal is being launched. The caller
 * dismisses it with `.dispose()` when the launch settles.
 *
 * Hide does not abort the request - it only takes the app-wide scrim away, so
 * a stalled launch cannot leave the user staring at a modal with no exit. If
 * the launch later succeeds the terminal simply appears. */
export function showLaunchSpinner(title: string): Dialog<unknown> {
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
    // the request is already on the wire and the terminal will still open and
    // take focus. A button named Cancel that does not cancel is worse than no
    // button.
    buttons: [Dialog.okButton({ label: 'Hide' })]
  });
  // `launch()` returns a promise nobody awaits - disposing an open Lumino
  // dialog rejects it with `undefined`, so swallow that here and keep a benign
  // teardown from surfacing as an unhandled rejection.
  dialog.launch().catch(() => undefined);
  return dialog;
}

/**
 * Terminals for one provider: the reuse ladder, the launch call and the tab
 * tint pass.
 *
 * Split out of the panel because none of it is presentation - it is process
 * identity. The panel asks for a conversation and gets a focused terminal
 * running exactly that conversation, or a fresh one; nothing in here knows
 * about sections, filters or menus.
 */
export class TerminalManager {
  constructor(options: TerminalManager.IOptions) {
    this._app = options.app;
    this._descriptor = options.descriptor;
    this._colours = options.colourStore;
    this._tracker = options.terminalTracker;
    this._colourfulTabs = options.colourfulTabs;
    this._serverSettings = options.serverSettings;
  }

  dispose(): void {
    this._disposed = true;
    this.stopColourLoop();
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
   */
  async openSession(
    session: ISession,
    mode: string | undefined,
    sessionId?: string
  ): Promise<void> {
    const wanted = sessionId ?? session.session_id;
    const key = this._key(session.project_path, wanted);
    const inFlight = this._pending.get(key);
    if (inFlight) {
      return inFlight;
    }
    const promise = this._doOpenSession(session, mode, wanted).finally(() => {
      this._pending.delete(key);
    });
    this._pending.set(key, promise);
    return promise;
  }

  private async _doOpenSession(
    session: ISession,
    mode: string | undefined,
    wanted: string
  ): Promise<void> {
    // 1. Microcache - the most recent terminal of this project, reused only
    // when it carries the wanted conversation.
    const cached = this._byProject.get(session.project_path);
    if (cached && !cached.widget.isDisposed && cached.sessionId === wanted) {
      this.focus(cached.widget);
      return;
    }

    // 2. Walk every live terminal, asking the server what each is running.
    const found = await this.findForSession(wanted);
    if (found) {
      // Tag with the OBSERVED conversation, so a later reuse trusts a
      // confirmed identity rather than a wish.
      this._byProject.set(session.project_path, {
        widget: found.widget,
        sessionId: found.runningId ?? undefined
      });
      this._wireDisposal(session.project_path, found.widget);
      this.focus(found.widget);
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
      wanted
    );
  }

  /**
   * Launch a terminal for one request and focus it. The returned widget is
   * tagged with `tagSessionId` in the microcache, so a later click on the row
   * that conversation now belongs to reuses this very terminal.
   */
  async launch(request: ILaunchRequest, tagSessionId?: string): Promise<any> {
    const spinner = showLaunchSpinner(`Opening ${this._descriptor.label}`);
    try {
      const launched = await requestProvider<ILaunchResponse>(
        this._descriptor.id,
        'launch',
        this._serverSettings,
        { method: 'POST', body: JSON.stringify(request) }
      );
      const widget: any = await this._app.commands.execute('terminal:open', {
        name: launched.terminal_name
      });
      if (widget?.id) {
        this._byProject.set(request.project_path, {
          widget,
          sessionId: tagSessionId
        });
        this._wireDisposal(request.project_path, widget);
        this.focus(widget);
      }
      return widget ?? null;
    } finally {
      spinner.dispose();
    }
  }

  /**
   * Bring a terminal tab to the front AND hand it keyboard focus, so typing
   * starts without a second click. `activateById` only reveals the tab; the
   * xterm inside does not reliably take DOM focus when the click came from the
   * sidebar, so the focus call is deferred to the next frame - by then the
   * widget is attached and visible.
   */
  focus(widget: any): void {
    if (!widget || widget.isDisposed) {
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

  /** Find an open terminal running exactly this conversation, or null.
   *
   * Matches on the conversation id ALONE. The server reads the true id from
   * the running process, so a session the user started by hand is recognised
   * too, not only launches that carry an argv id. An id is globally unique to
   * one conversation, so a terminal holding it IS the one to focus, whatever
   * cwd it reports - a process that changed directory, or whose project dir
   * was recreated, must still be reused rather than duplicated. */
  async findForSession(
    wantedSessionId: string | undefined
  ): Promise<{ widget: any; runningId: string | null } | null> {
    if (!this._tracker || !wantedSessionId) {
      return null;
    }
    for (const widget of this._liveTerminals()) {
      const info = await this.probe(widget);
      if (info && info.session_id && info.session_id === wantedSessionId) {
        return { widget, runningId: info.session_id };
      }
    }
    return null;
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
   * goes stale on an in-place switch. On the way through, a colour the user
   * set by hand on the tab is written back into this provider's colour store,
   * which is what makes "set the tab colour" mean "this conversation's colour"
   * even for an assistant whose CLI has no colour concept.
   */
  async reconcileColours(): Promise<void> {
    if (!this._colouredTabs) {
      // No rearm: `setColouredTabs(true)` calls straight back in here.
      return;
    }
    try {
      await this._eachAssistantTerminal(async (widget, info) => {
        const sessionId =
          info.session_id ??
          sessionForCwds(info.cwds ?? [], this._sessions)?.session_id ??
          null;
        const terminalName: string = widget?.content?.session?.name ?? '';

        // Write-back. The tab is the control surface for EVERY assistant,
        // native-colour ones included: setting a colour there diverges from
        // whatever the CLI's own colour said, and that later choice is the one
        // remembered from here on.
        //
        // Keyed on the OBSERVED conversation only. `sessionId` above may be the
        // project's representative conversation resolved from a cwd, which is
        // good enough to paint with but not to write against: filing the user's
        // colour under a guessed id recolours a conversation they never touched.
        const userSet = terminalName
          ? readUserSetTabColour(terminalName)
          : null;
        if (userSet) {
          const observedId = info.session_id ?? null;
          // Held by the store already (an earlier pass captured it), or
          // captured right now with the write confirmed by the server.
          // Held AS THE USER'S OWN. Matching the colour alone is not enough: a
          // branch born wearing this tint holds it as inherited, so re-picking
          // the same colour on that tab would be swallowed and the choice
          // would never become releasable. The cache carries only values the
          // server confirmed, so reading it is the confirmation - which is why
          // it is never written ahead of the answer.
          let held =
            !!observedId &&
            this._colours.get(observedId) === userSet &&
            this._colours.isOverride(observedId);
          if (observedId && !held) {
            // Strip OUR tint from `title.className` first. The companion
            // extension's menu writes its own storage and the tab ELEMENT's
            // classes, never the title - and Lumino rebuilds that element's
            // class attribute from the title whenever the current tab changes,
            // so a tint of ours still sitting there comes back over the colour
            // the user just picked. With the title bare, the companion's own
            // refresh holds their choice until this write confirms.
            this._applyColour(widget, null);
            held = await this._colours.set(observedId, userSet);
          }
          if (!held) {
            // Nothing remembers this colour yet, so painting one would destroy
            // it: any colour applied makes the colourful-tab extension release
            // its menu entry. Strip OUR tint instead and stop - Lumino rebuilds
            // the tab's classes from `title.className`, so a tint left there by
            // an earlier pass would otherwise keep showing in place of the
            // colour the user just picked, and the companion repaints its own
            // once the class is gone. The next pass retries the capture.
            this._applyColour(widget, null);
            return;
          }
        }

        const native =
          info.colour ??
          (sessionId
            ? (this._sessions.find(s => s.session_id === sessionId)?.colour ??
              null)
            : null);
        this._applyColour(
          widget,
          effectiveColour(
            sessionId,
            this._descriptor.colourSource,
            this._colours.get(sessionId),
            native
          )
        );
      });
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

  /** Effective colour of one conversation as the cache currently reads it, for
   * branch inheritance at the fork sites.
   *
   * A snapshot, not the last word: the cache holds only server-confirmed
   * values, so a colour still being written is not in it. The fork path settles
   * the store and re-reads before it copies anything, and keeps this answer as
   * the fallback for a conversation the store holds nothing for - see
   * `_inheritColour` (DEF-31). */
  colourFor(session: ISession, sessionId?: string): string | null {
    const id = sessionId ?? session.session_id;
    return effectiveColour(
      id,
      this._descriptor.colourSource,
      this._colours.get(id),
      session.colour ?? null
    );
  }

  /** Drop the tint from this assistant's terminals. Only its own terminals are
   * touched, so a tint the user set by hand on another tab survives.
   *
   * Swallows like `reconcileColours`, and for the same reason: both reach into
   * another extension, both are called as `void`, and turning tab colouring
   * off must not spill an unhandled rejection. */
  async clearColours(): Promise<void> {
    try {
      await this._eachAssistantTerminal(async widget => {
        this._applyColour(widget, null);
      });
    } catch (_err) {
      // Nothing to retry - the setting is off either way.
    }
  }

  private _applyColour(widget: any, colourId: string | null): void {
    if (!this._colourfulTabs || !widget || widget.isDisposed) {
      return;
    }
    this._colourfulTabs.setColour(widget, colourId);
  }

  private async _eachAssistantTerminal(
    apply: (widget: any, info: ITerminalProbeResponse) => void | Promise<void>
  ): Promise<void> {
    if (!this._colourfulTabs || !this._tracker) {
      return;
    }
    const widgets = this._liveTerminals();
    await Promise.all(
      widgets.map(async widget => {
        const info = await this.probe(widget);
        if (!info || !info.running || widget.isDisposed) {
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
  private readonly _colours: ColourStore;
  private readonly _tracker: ITerminalTracker | null;
  private readonly _colourfulTabs: IColourfulTabs | null;
  private readonly _serverSettings: ServerConnection.ISettings;
  // Most recent terminal per project, tagged with the conversation it runs so
  // reuse can tell a project's branches apart.
  private readonly _byProject: Map<
    string,
    { widget: any; sessionId?: string }
  > = new Map();
  // In-flight launches keyed per CONVERSATION, so two branches of one project
  // open independently and concurrently.
  private readonly _pending: Map<string, Promise<void>> = new Map();
  private _sessions: ISession[] = [];
  private _colouredTabs = true;
  private _colourHandle: number | null = null;
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
  }
}
