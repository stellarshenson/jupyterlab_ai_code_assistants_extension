// The Claude Code provider.
//
// Ported from `jupyterlab_claude_code_extension` v1.2.73, the architectural
// base. Almost all of that extension's behaviour is now the shared core, and
// what is left here is what only Claude has: the capability flags on the
// descriptor, and the two places where "a live background agent holds this
// conversation" changes what the user is offered.
//
// Nothing here touches the DOM outside its own badge element, and nothing here
// reaches into core internals - the hooks are the whole seam.

import { IProviderDescriptor, IProviderHooks, ISession } from '../core/types';

// Claude's own mark, drawn as a single path group so the theme's `jp-icon3`
// fill drives it in both light and dark.
const claudeSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <g class="jp-icon3" fill="#616161">
    <path d="m14.375 6.48.49.28v.209l-.14.489-5.937 1.397-.558-1.387zm0 0"/>
    <path d="m12.155 2.373.683.143.182.224.173.535-.072.342-3.983 5.447L7.81 7.737l3.673-4.82z"/>
    <path d="m8.719 1.522.419-.28.349.14.349.49-.957 5.748-.65-.441-.279-.769.49-4.33z"/>
    <path d="m4.239 1.614.43-.55L4.95 1l.558.081.275.216 2.004 4.442.724 2.11-.848.471-3.231-5.864z"/>
    <path d="m2.154 4.665-.14-.56.42-.488.488.07h.14l2.933 2.165.908.698 1.257.978-.698 1.187-.629-.489-.419-.419-4.05-2.863z"/>
    <path d="M1.316 8.296 1 7.946v-.31l.316-.108 3.562.21 3.491.279-.113.695-6.66-.346z"/>
    <path d="M3.411 11.931h-.698l-.278-.32v-.382l1.186-.838 4.82-3.068.487.833z"/>
    <path d="m4.738 13.883-.28.07-.418-.21.07-.35 4.12-5.446.558.768-3.072 4.05z"/>
    <path d="m8.23 14.581-.21.28-.419.14-.349-.28-.21-.42L8.09 8.646l.629.07z"/>
    <path d="M11.791 13.045v.558l-.07.21-.279.14-.489-.066-3.356-4.996 1.331-1.014 1.117 2.025.105.733z"/>
    <path d="m13.398 12.207.07.349-.21.279-.21-.07-1.187-.838-1.815-1.606-1.397-.978.419-1.326.698.419.42.768z"/>
    <path d="m12.49 8.645 1.746.14.419.28.279.418v.302l-.768.327-3.911-.978-1.606-.07.419-1.466 1.117.838z"/>
  </g>
</svg>`;

export const descriptor: IProviderDescriptor = {
  id: 'claude',
  label: 'Claude Code',
  panelTitle: 'Claude Code Sessions',
  iconName: 'jupyterlab_ai_code_assistants_extension:claude',
  iconSvg: claudeSvgStr,
  cliBinary: 'claude',
  // `claude --fork-session --session-id <uuid>`: the CLI forks in-process and
  // takes the new id from us, so the fork is known before it exists - and its
  // store entry is written lazily, on the first turn, which is what the core's
  // branch watcher waits for.
  forkStrategy: 'native-flag',
  // `/color` is Claude's own surface for a conversation's colour, recorded in
  // its transcript, so the assistant supplies the DEFAULT tint - a colour the
  // user then sets on the tab diverges from it deliberately and wins.
  colourSource: 'native',
  // `-n <name>` at launch: Claude stamps the name itself and re-stamps it on
  // every turn, which is the only way a fork's name survives - a title written
  // after the fact loses to the parent title the fork inherits.
  promptsForBranchName: true,
  mintsNewSessionId: true,
  launchModes: [
    {
      id: 'dangerouslySkipPermissions',
      title: 'Dangerously skip permissions',
      description:
        'When enabled, newly spawned and resumed sessions are launched with `--dangerously-skip-permissions`. Bypasses every Claude Code permission prompt - only enable in sandboxes you trust.',
      default: false,
      menuLabel: 'Skip Permissions'
    }
  ],
  hasRemoteControl: true,
  hasBgAgents: true,
  // Claude records the conversation a process is on, so a terminal is
  // identified exactly; there is no per-project "something is running here"
  // signal to render.
  hasLiveProcess: false,
  // Retired standalone extension this provider replaces.
  legacyPluginId: 'jupyterlab_claude_code_extension'
};

export const hooks: IProviderHooks = {
  // Joining a live agent and resuming a dormant conversation are different
  // verbs, so the item says which one this row gets before the click.
  resumeLabel: (session: ISession | null) =>
    session?.bg_id ? 'Attach to Background Agent' : 'Resume'
};
