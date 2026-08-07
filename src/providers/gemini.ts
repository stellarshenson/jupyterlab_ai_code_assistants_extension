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

// The four-pointed spark of the Gemini mark: four tips on the box edges, each
// pair joined by a quadratic whose control point is the centre, which is what
// pinches the sides inwards. Single path, `jp-icon3` so the theme drives the
// fill in both light and dark; the 16px box matches every other icon in the
// sidebar.
const geminiSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M8 0Q8 8 16 8Q8 8 8 16Q8 8 0 8Q8 8 8 0Z"/>
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
