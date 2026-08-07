// The Gemini provider - Google's `gemini` CLI.
//
// New here: no standalone extension preceded it, so there is nothing to port
// and nothing to migrate. Everything that makes this assistant different from
// the base one is descriptor data, so no core file knows it exists:
//
// * `forkStrategy: 'server-copy'` - gemini has no fork verb at all, so the
//   server copies the chat file under a fresh id and answers with it
// * `colourSource: 'none'` - no colour command, and nothing in the chat store
//   records one, so a tab tint only ever comes from the extension's own
//   write-back store
// * `namingStrategy: 'server-side'` - a fork's name is stamped into the copied
//   chat file's `summary`, which is the field the CLI itself displays a
//   conversation under; there is no naming flag to pass it to
// * `mintsNewSessionId: true` - `--session-id <uuid>` starts a fresh
//   conversation under an id we chose, so a new session is identifiable from
//   its argv on the first poll instead of being an unknown terminal
// * two launch modes, gemini's `--yolo` switch and its four-step approval
//   ladder
//
// No hooks: gemini rows carry no badge, no extra menu item and no derived
// colour, so the shared panel renders them unchanged.

import { IProviderDescriptor } from '../core/types';

// The official Gemini spark - the silhouette path of Google's 2025 icon
// (rounded four-point star; the upstream asset fills it with gradient blobs,
// dropped here because every sidebar icon is monochrome). Single path,
// `jp-icon3` so the theme drives the fill in both light and dark; the 16px
// box matches every other icon in the sidebar.
const geminiSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 65 65" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z"/>
</svg>`;

// Gemini's own names for its two launch surfaces. Kept in the assistant's
// terminology rather than normalised, because each is both the settings key
// under `providers.gemini.` and the mode token the server maps to a CLI flag.
const YOLO_MODE = 'yoloMode';
const APPROVAL_MODE = 'approvalMode';

export const descriptor: IProviderDescriptor = {
  id: 'gemini',
  label: 'Gemini',
  panelTitle: 'Gemini Sessions',
  iconName: 'jupyterlab_ai_code_assistants_extension:gemini',
  iconSvg: geminiSvgStr,
  cliBinary: 'gemini',
  // No fork flag exists, so the server copies the chat file under a fresh id
  // and the launch resumes that id like any other conversation.
  forkStrategy: 'server-copy',
  colourSource: 'none',
  // The fork's name is written into the copy by the server; the CLI has no
  // naming flag to take it.
  namingStrategy: 'server-side',
  // `--session-id <uuid>` starts a conversation under an id we mint.
  mintsNewSessionId: true,
  launchModes: [
    {
      id: YOLO_MODE,
      title: 'YOLO mode',
      description:
        'When enabled, newly spawned and resumed sessions are launched with `--yolo`. Gemini auto-approves every tool call without asking - only enable in workspaces you trust.',
      kind: 'boolean',
      default: false,
      menuLabel: 'YOLO'
    },
    {
      id: APPROVAL_MODE,
      title: 'Approval mode',
      description:
        'Approval ladder passed as `--approval-mode` when set to a value other than the default. A non-default value here takes precedence over the YOLO switch; only the forced YOLO menu action overrides it. `default` prompts for approval, `auto_edit` auto-approves edit tools, `yolo` auto-approves every tool, `plan` is read-only.',
      kind: 'enum',
      values: ['default', 'auto_edit', 'yolo', 'plan'],
      default: 'default'
    }
  ],
  hasRemoteControl: false,
  hasBgAgents: false,
  hasLiveProcess: false
};
