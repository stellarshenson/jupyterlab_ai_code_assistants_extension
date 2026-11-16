// The Antigravity provider - Google's `agy` CLI, the Gemini CLI's successor.
//
// New here: no standalone extension preceded it, so there is nothing to port
// and nothing to migrate. Everything that makes this assistant different from
// the base one is descriptor data, so no core file knows it exists:
//
// * `forkStrategy: 'server-copy'` - agy's `/fork` works only inside its TUI,
//   so the server copies the conversation under a fresh id and answers with it
// * `colourSource: 'none'` - no colour command, and nothing in the store
//   records one, so a tab tint only ever comes from the extension's own
//   write-back store
// * `mintsNewSessionId: false` - a bare `agy` starts a conversation whose id
//   the CLI mints itself; nothing on the command line takes one, so a new
//   session's row appears on the first poll after agy writes it
// * one launch mode, `--dangerously-skip-permissions`, under the flag's own
//   name
//
// The store under `~/.gemini/antigravity-cli/`, as measured on agy 1.5.9
// (tmp/workflows/agy-real/findings.md):
//
// * `conversations/<uuid>.db` is the conversation, a SQLite db; the uuid is
//   its id. A conversation whose db is gone is not listed
// * `conversation_summaries.db` lists them: `workspace_uris` holds the
//   `file://` URI of the folder agy ran in, which is the project. agy rebuilds
//   it on every start, so it is read and never written
// * the name is `title:"<name>"` in `annotations/<uuid>.pbtxt`, which agy's
//   `/rename` writes and reads back on start; rename writes the same file.
//   The row label is that title, else the summary's title, else its preview,
//   else the short id - never the transcript, whose prompts agy wraps in
//   `<USER_REQUEST>` tags
// * a copy of `conversations/<uuid>.db` with the old id replaced by the new
//   one everywhere, plus `brain/<uuid>/`, is a branch agy resumes
// * `agy --conversation <id>` resumes that conversation under the same id
//
// No hooks: rows carry no badge, no extra menu item and no derived colour, so
// the shared panel renders them unchanged.

import { IProviderDescriptor } from '../core/types';

// Antigravity's own mark - the arch of its logo (antigravity.google
// favicon.svg). Single path, `jp-icon3` so the theme drives the fill in both
// light and dark; the viewBox insets the mark to the JupyterLab icon
// proportion (see `providerIcon`).
const antigravitySvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="5.587 6.794 100.302 100.302" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z"/>
</svg>`;

// agy's own name for its approval switch, the flag spelled in camelCase. It is
// both the settings key under `providers.antigravity.` and the mode token the
// server maps to the flag.
const SKIP_PERMISSIONS_MODE = 'dangerouslySkipPermissions';

export const descriptor: IProviderDescriptor = {
  id: 'antigravity',
  label: 'Antigravity',
  panelTitle: 'Antigravity',
  iconName: 'jupyterlab_ai_code_assistants_extension:antigravity',
  iconSvg: antigravitySvgStr,
  cliBinary: 'agy',
  // No fork flag exists, so the server copies the conversation under a fresh
  // id and the launch resumes that id like any other conversation.
  forkStrategy: 'server-copy',
  colourSource: 'none',
  // The name is `annotations/<id>.pbtxt`, which agy's own `/rename` writes.
  canRename: true,
  mintsNewSessionId: false,
  launchModes: [
    {
      id: SKIP_PERMISSIONS_MODE,
      title: 'Dangerously skip permissions',
      description:
        'Launch new and resumed sessions with `--dangerously-skip-permissions`; tool calls run unasked.',
      default: false,
      menuLabel: 'Skip Permissions'
    }
  ],
  hasRemoteControl: false,
  hasBgAgents: false,
  hasLiveProcess: false
};
