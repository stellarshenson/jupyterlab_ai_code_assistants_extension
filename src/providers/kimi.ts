// The Kimi provider - Moonshot AI's `kimi` CLI.
//
// Ported from jupyterlab_kimi_code_extension v0.7.8. Everything that made that
// extension different from the base one is declared here as descriptor data,
// so no core file knows this assistant exists:
//
// * `forkStrategy: 'server-copy'` - kimi has no fork verb at all, so the
//   server copies the session directory and answers with the new id
// * `colourSource: 'derived'` - kimi has no `/color`, so the default tint is a
//   stable hash of the conversation id (a user-set colour still wins, per the
//   Colour section of the acceptance criteria)
// * `promptsForBranchName: true` - the branch flow asks for a name, which the
//   server stamps into the copied `state.json`, not passed to the CLI
// * one launch mode, `--yolo`, under kimi's own name
// * `sessionIdPrefix: 'session_'` - every id carries it, so the short id the
//   panel shows is sliced past it

import { IProviderDescriptor } from '../core/types';

// The official Kimi "K" mark from Moonshot's branding guide (the k-only
// glyph, the same shape kimi.com uses as its favicon): the angular K with the
// detached rounded accent square at the top right. Both paths sit in one
// `jp-icon3` group so the accent renders in the theme foreground rather than
// Kimi's brand blue - every icon in the sidebar is monochrome.
const kimiSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 25" width="16" height="16">
  <g class="jp-icon3" fill="#616161">
    <path d="M21.7202 0.939941C22.9502 0.939941 23.9502 1.93994 23.9502 3.16994C23.9502 4.39994 22.9502 5.39994 21.7202 5.39994H19.7502C19.6002 5.39994 19.4902 5.27994 19.4902 5.13994V3.16994C19.4902 1.93994 20.4902 0.939941 21.7202 0.939941Z"/>
    <path d="M9.39 13.9501L17.82 5.59012C17.98 5.43012 17.89 5.12012 17.68 5.12012H13.14C13.14 5.12012 13.04 5.14012 13 5.18012L3.92 14.1901C3.78 14.3301 3.57 14.2101 3.57 13.9801V5.39012C3.57 5.24012 3.47 5.12012 3.35 5.12012H0.219999C0.0999993 5.12012 0 5.24012 0 5.39012V23.9201C0 24.0701 0.0999993 24.1901 0.219999 24.1901H3.35C3.47 24.1901 3.57 24.0701 3.57 23.9201V20.1401C3.57 20.0601 3.6 19.9801 3.65 19.9301L6.47 17.1401C6.54 17.0701 6.63 17.0601 6.71 17.1101L14.24 22.6501C15.47 23.4801 16.85 23.9901 18.25 24.1401C18.37 24.1501 18.48 24.0301 18.48 23.8701V20.3101C18.48 20.1701 18.4 20.0601 18.29 20.0501C17.47 19.9201 16.66 19.6001 15.94 19.1101L9.42 14.3901C9.28 14.3001 9.27 14.0701 9.39 13.9501Z"/>
  </g>
</svg>`;

// -------------------------------------------------------------- descriptor

export const descriptor: IProviderDescriptor = {
  id: 'kimi',
  label: 'Kimi',
  panelTitle: 'Kimi Code Sessions',
  iconName: 'jupyterlab_ai_code_assistants_extension:kimi',
  iconSvg: kimiSvgStr,
  cliBinary: 'kimi',
  // No fork flag exists, so the server copies the session directory under a
  // fresh id and the launch resumes that id like any other conversation.
  forkStrategy: 'server-copy',
  // No `/color` command either: the tint is derived from the conversation id.
  // The core's own FNV-1a is the same hash over the same six ids the retired
  // extension used, so every conversation keeps the colour it already had.
  colourSource: 'derived',
  terminalScope: 'conversation',
  // The fork's name is written into the copy's `state.json` by the server; the
  // CLI has no naming flag to take it.
  promptsForBranchName: true,
  // A bare `kimi` mints its own id and writes it on the first turn, and `-S`
  // only ever resumes - so a new conversation cannot be launched under an id
  // we chose, and is identified from the store on the next poll instead.
  mintsNewSessionId: false,
  // Kimi ids are `session_<uuid>`; the short id is the uuid's head.
  sessionIdPrefix: 'session_',
  launchModes: [
    {
      id: 'yoloMode',
      title: 'YOLO mode',
      description:
        'When enabled, newly spawned and resumed sessions are launched with `--yolo`. Kimi auto-approves regular tool calls without asking - only enable in workspaces you trust.',
      default: false,
      menuLabel: 'YOLO'
    }
  ],
  hasRemoteControl: false,
  hasBgAgents: false,
  hasLiveProcess: false,
  // Retired standalone extension this provider replaces.
  legacyPluginId: 'jupyterlab_kimi_code_extension'
};
