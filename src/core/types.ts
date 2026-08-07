// Shared vocabulary of the provider core. Nothing here names an assistant:
// every divergence between the registered providers is expressed as a
// capability flag on the descriptor, or as an optional hook the provider
// module supplies. Adding an assistant adds a descriptor, never a branch in
// core code.

/** How a conversation is branched.
 *
 * - `native-flag` - the CLI forks in-process from a flag pair, and the new
 *   conversation id is minted by the frontend, so the launch carries it and
 *   the branch is watched for until its store entry materialises
 * - `native-command` - the CLI owns the fork verb AND mints the id itself, so
 *   the id has to be discovered by diffing the branch list after launch
 * - `server-copy` - the CLI has no fork at all; the server copies the store
 *   entry, answers with the new id, and the launch resumes that id
 */
export type ForkStrategy = 'native-flag' | 'native-command' | 'server-copy';

/** Where a conversation's DEFAULT tab tint comes from. A user-set colour in
 * the extension's own write-back store always wins over all three. */
export type ColourSource = 'native' | 'derived' | 'none';

/** Who owns a branched conversation's name.
 *
 * - `launch-flag` - the CLI is told the name at launch and stamps it itself
 * - `server-side` - the server writes the name into the copied store entry
 * - `none` - the assistant has no naming surface, so no name is asked for
 */
export type NamingStrategy = 'launch-flag' | 'server-side' | 'none';

/** One launch-behaviour setting of an assistant, in that assistant's own
 * terminology. `boolean` modes are the unsafe/skip-approval switches: they get
 * a settings toggle (off by default) AND a context-menu launch variant.
 * `enum` modes are settings-only choices passed through on every launch. */
export interface ILaunchMode {
  /** Settings key under `providers.<id>.` and launch-payload key. Uses the
   * assistant's own terminology, never a normalised core name. */
  id: string;
  /** Settings title shown in the JupyterLab settings editor. */
  title: string;
  /** Settings description. */
  description: string;
  kind: 'boolean' | 'enum';
  /** Allowed values, `enum` modes only. */
  values?: string[];
  /** Default value. Boolean modes default to `false` without exception. */
  default: boolean | string;
  /** Menu label for the launch variant this mode produces, e.g.
   * `Skip Permissions`. Boolean modes only; absent means settings-only. */
  menuLabel?: string;
}

/** Everything the core needs to know about one assistant. Pure data - no
 * JupyterLab imports - so the settings-schema generator can read it under
 * plain Node from the compiled barrel. */
export interface IProviderDescriptor {
  /** Stable id. Drives the route namespace, widget id, command namespace,
   * settings keys and localStorage keys. */
  id: string;
  /** Display label, e.g. used in settings and dialogs. */
  label: string;
  /** Panel title and tab caption. */
  panelTitle: string;
  /** LabIcon name for the panel icon. Registered by the core registry. */
  iconName: string;
  /** SVG source for that icon. Kept as a string so the descriptor carries no
   * JupyterLab dependency; the registry builds the LabIcon. */
  iconSvg: string;
  /** Binary probed on PATH server-side. Absence disables this provider only. */
  cliBinary: string;
  forkStrategy: ForkStrategy;
  colourSource: ColourSource;
  namingStrategy: NamingStrategy;
  /** The CLI starts a brand-new conversation under an id we give it, so a
   * fresh session is identifiable from its argv on the first poll instead of
   * being an unknown terminal until it writes its store entry. Independent of
   * `forkStrategy` - an assistant can accept an id for a new session and still
   * have no fork verb at all. */
  mintsNewSessionId: boolean;
  launchModes: ILaunchMode[];
  /** Sessions can be held under remote control - renders the indicator dot. */
  hasRemoteControl: boolean;
  /** Sessions can be owned by a live background agent - renders the chip and
   * asks the branch endpoint for agent state. */
  hasBgAgents: boolean;
  /** Projects can show a live-process indicator. */
  hasLiveProcess: boolean;
  /** JupyterLab plugin id of the retired standalone extension this provider
   * replaces, without the `:plugin` suffix. Present only for a provider that
   * had one: if that plugin is still installed the core suppresses this
   * provider's panel rather than docking a second one for the same assistant.
   */
  legacyPluginId?: string;
}

/** One project row. Fields past `extra_sessions` are capability-gated: a
 * provider whose descriptor does not claim the capability simply omits them,
 * and the panel renders nothing for them. */
export interface ISession {
  project_path: string;
  /** The provider's own project key. Opaque to the core - it is only ever
   * echoed back to that provider's routes. */
  encoded_path: string;
  session_id: string;
  name: string;
  name_source: 'session' | 'basename';
  message_count: number;
  /** Last activity, epoch milliseconds. */
  file_mtime: number;
  git_branch: string | null;
  favourite: boolean;
  /** Conversations of this project beyond the current one. */
  extra_sessions: number;
  summary?: string;
  first_prompt?: string;
  created?: string | number | null;
  modified?: string | number | null;
  /** The conversation's own colour, for `colourSource: 'native'` providers.
   * One of the six colour ids, or null. */
  colour?: string | null;
  /** Remote control is active on this conversation (`hasRemoteControl`). */
  remote_control?: boolean;
  /** Short id of the live background agent holding this conversation
   * (`hasBgAgents`), or null. Display only - the server picks the launch verb
   * itself, where it cannot be stale. */
  bg_id?: string | null;
  /** A process of this assistant is running in this project
   * (`hasLiveProcess`). */
  live?: boolean;
  /** Model the conversation last ran on, when the store records one. */
  model?: string | null;
  tokens_used?: number;
}

export interface ISessionsListResponse {
  sessions: ISession[];
}

/** One registered provider as the server sees it. */
export interface IProviderStatus {
  id: string;
  label: string;
  /** The `providers.<id>.enabled` setting as the server last read it. */
  enabled: boolean;
  cli_path: string | null;
  /** Enabled AND binary present - the only state that docks a panel. */
  available: boolean;
}

export interface IStatusResponse {
  root_dir: string;
  providers: IProviderStatus[];
  /** JupyterLab's own move-to-trash setting, read server-side, so dialogs say
   * which of the two a click means rather than reciting both. */
  delete_to_trash?: boolean;
}

export interface IFavouriteRequest {
  project_path: string;
  favourite: boolean;
}

export interface IFavouriteResponse {
  favourites: string[];
}

/** Destructive endpoints answer with the count AND the ids that actually went,
 * because a shortfall is not a failure: whatever was disposed of is gone, so
 * the count has to reach the user - and only the ids named here may have their
 * stored colour dropped, or a conversation whose deletion was refused loses its
 * tint. */
export interface IDisposalReport {
  removed_count: number;
  removed_ids: string[];
}

export type IRemoveResponse = IDisposalReport;

export type ICleanupResponse = IDisposalReport;

export type IDeleteSessionsResponse = IDisposalReport;

export interface IBranch {
  session_id: string;
  file_mtime: number;
  label: string;
  /** Live background agent owning this branch (`hasBgAgents`), or null.
   * Populated only when the fetch asked for it. */
  bg_id?: string | null;
}

export interface IBranchesResponse {
  current: string;
  total: number;
  branches: IBranch[];
}

export interface ISwitchResponse {
  requested: string;
  current: string | null;
}

export interface IForkRequest {
  encoded_path: string;
  session_id: string;
  name?: string;
}

export interface IForkResponse {
  session_id: string;
}

export interface ILaunchRequest {
  project_path: string;
  /** The project's store key. Carrying it arms the server's launch-time pin
   * bookkeeping (a native-flag fork pins itself current, a new session clears
   * a stale pin) and the session_not_found pre-flight - without it both are
   * silently skipped. Send it whenever the session row is in hand. */
  encoded_path?: string;
  /** Conversation to open. Omit to start a brand-new one. */
  session_id?: string;
  /** Frontend-minted id for a brand-new conversation, when the CLI accepts
   * one, so the terminal is identifiable from its argv on the first poll. */
  new_session_id?: string;
  /** Frontend-minted id for the fork (`forkStrategy: 'native-flag'`). */
  fork_session_id?: string;
  /** Parent conversation to fork from (`forkStrategy: 'native-command'`). */
  fork_from?: string;
  /** Name to stamp on the new conversation (`namingStrategy: 'launch-flag'`). */
  name?: string;
  /** The launch mode this action runs under, as one token in the assistant's
   * own terminology: a boolean mode is its bare `ILaunchMode.id`, an enum mode
   * is `<id>=<value>`. One token, not a set - the server maps a single mode to
   * a single flag, and refuses any token the descriptor does not declare with
   * 400 `mode_unsupported`. */
  mode?: string;
}

export interface ILaunchResponse {
  terminal_name: string;
}

/** What a terminal is running, as the server resolved it from `/proc`. */
export interface ITerminalProbeResponse {
  terminal_name: string;
  /** The assistant's binary is the pty's process. */
  running: boolean;
  /** Conversation the running process holds, or null when unreadable. */
  session_id?: string | null;
  /** That conversation's own colour (`colourSource: 'native'`). */
  colour?: string | null;
  /** Working directories read from `/proc`, never from `PWD`. */
  cwds?: string[];
}

/** What one provider carried over from its retired standalone extension.
 * `keys` are settings this extension is to apply through the settings registry,
 * which the server has no writable handle on. */
export interface IMigratedProvider {
  provider_id: string;
  keys: Record<string, boolean | number | string>;
  favourites: string[];
}

/** `POST migrate`. Idempotent - a second call reports an empty list. */
export interface IMigrateResponse {
  migrated: IMigratedProvider[];
}

/** The extension's own per-provider colour store: user-set tab colours keyed
 * by conversation id. */
export interface IColourStoreResponse {
  colours: Record<string, string>;
}

// ------------------------------------------------------------------- hooks

/** Everything a provider hook is handed about the row it is describing. */
export interface IHookContext {
  session: ISession;
  descriptor: IProviderDescriptor;
}

/** Optional behaviour a provider module supplies on top of its descriptor.
 * Every hook is optional - a provider that supplies none renders the plain
 * shared panel. */
export interface IProviderHooks {
  /** Label for the primary open action, when the provider distinguishes verbs
   * (joining a live worker is not the same as resuming a dormant store entry). */
  resumeLabel?: (session: ISession | null) => string;
  /** Extra lines for the row tooltip. */
  tooltipLines?: (ctx: IHookContext) => string[];
  /** Menu label for one branch. Defaults to `<label> (<short id>) - <time>`;
   * a provider whose titles are written in wide scripts overrides it to bound
   * the menu by display columns rather than by code units. */
  branchLabel?: (branch: IBranch, shortId: string) => string;
  /** Chip appended to a branch row in the menu and the popup. */
  branchBadge?: (branch: IBranch) => HTMLElement | null;
}

/** What `providers/index.ts` registers: one descriptor, optionally with hooks. */
export interface IProviderModule {
  descriptor: IProviderDescriptor;
  hooks?: IProviderHooks;
}
