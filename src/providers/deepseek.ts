// The DeepSeek provider - the DeepSeek Harness `dsh` CLI.
//
// New here: no standalone extension preceded it, so there is nothing to port
// and nothing to migrate. The harness has no interactive terminal surface -
// `dsh --profile web` serves a browser UI over the project's conversations and
// `dsh --profile headless` runs one task and exits - so a launch starts the
// web server in the project directory and the terminal shows the URL to open.
// Everything that makes this assistant different is descriptor data, so no
// core file knows it exists:
//
// * `forkStrategy: 'server-copy'` - no fork verb at all, so the server copies
//   the conversation log under a fresh id and answers with it
// * `colourSource: 'none'` - no colour command, and nothing in the log records
//   one, so a tab tint only ever comes from the extension's own write-back
//   store
// * `promptsForBranchName: true` - the branch flow asks for a name, which the
//   server writes into the copied log's title event, the field the harness
//   itself displays a conversation under
// * `mintsNewSessionId: false` - the web UI mints its own ids when a
//   conversation is started in the browser; nothing on the command line takes
//   one
// * `sessionIdPrefix: 'session-'` - every id is `session-<uuid>`, so the short
//   id shown in menus is sliced past the constant part
// * no launch modes: the web surface has no approval switch on its command
//   line
//
// One hook: the open verb. A click does not resume the row's conversation in
// the terminal, it serves the project's web UI - the label says so before the
// click.

import { IProviderDescriptor, IProviderHooks } from '../core/types';

// A whale silhouette after DeepSeek's mark, reduced to one monochrome path:
// head to the left, the fluke raised at the right, an eye cut out with the
// even-odd rule. `jp-icon3` so the theme drives the fill in both light and
// dark; the 16px box matches every other icon in the sidebar.
const deepseekSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <path class="jp-icon3" fill="#616161" fill-rule="evenodd" d="M2 12c0-3.6 3-6.5 6.6-6.5h3.2c3.3 0 6.1 2.1 7 5l2.4-2.5c.5-.5 1.4 0 1.2.7l-1.2 3.3 1.2 3.3c.2.7-.7 1.2-1.2.7l-2.4-2.5c-.9 2.9-3.7 5-7 5H8.6C5 18.5 2 15.6 2 12zm6-2.6a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2z"/>
</svg>`;

export const descriptor: IProviderDescriptor = {
  id: 'deepseek',
  label: 'DeepSeek',
  panelTitle: 'DeepSeek Sessions',
  iconName: 'jupyterlab_ai_code_assistants_extension:deepseek',
  iconSvg: deepseekSvgStr,
  cliBinary: 'dsh',
  forkStrategy: 'server-copy',
  colourSource: 'none',
  promptsForBranchName: true,
  mintsNewSessionId: false,
  sessionIdPrefix: 'session-',
  launchModes: [],
  hasRemoteControl: false,
  hasBgAgents: false,
  hasLiveProcess: false
};

export const hooks: IProviderHooks = {
  // The terminal serves the web UI and prints its URL; the conversation is
  // then chosen in the browser. Naming that here is what keeps a click from
  // reading as a resume that silently opened something else.
  resumeLabel: () => 'Open Web UI'
};
