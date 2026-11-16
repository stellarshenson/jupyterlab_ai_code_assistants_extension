// The Copilot provider - GitHub's `copilot` CLI (npm `@github/copilot`).
//
// New here: no standalone extension preceded it, so there is nothing to port
// and nothing to migrate. Everything that makes this assistant different from
// the base one is descriptor data, so no core file knows it exists:
//
// * `forkStrategy: 'server-copy'` - `/fork` exists only inside the TUI and no
//   command-line flag forks, so the server copies the session directory under
//   a fresh id and answers with it
// * `colourSource: 'none'` - no colour command, and nothing in the session
//   store records one, so a tab tint only ever comes from the extension's own
//   write-back store
// * `mintsNewSessionId: true` - `--session-id <uuid>` starts a fresh session
//   under an id we chose when nothing matches it, so a new session is
//   identifiable from its argv on the first poll
// * one launch mode, `--yolo`, under the CLI's own name
//
// No hooks: copilot rows carry no badge, no extra menu item and no derived
// colour, so the shared panel renders them unchanged.

import { IProviderDescriptor } from '../core/types';

// GitHub's Copilot mark - Primer Octicons `copilot-16`, @primer/octicons
// 19.15.0, MIT licence, (c) GitHub Inc. The two upstream paths (head, eyes)
// are joined into one, `jp-icon3` so the theme drives the fill in both light
// and dark; the viewBox insets the mark to the JupyterLab icon proportion
// (see `providerIcon`).
const copilotSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.6 -1.6 19.2 19.2" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.012.076.024.148.037.218.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7ZM6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z"/>
</svg>`;

// Copilot's own name for its approval switch. Kept in the assistant's
// terminology rather than normalised, because it is both the settings key
// under `providers.copilot.` and the mode token the server maps to a CLI flag.
const YOLO_MODE = 'yoloMode';

export const descriptor: IProviderDescriptor = {
  id: 'copilot',
  label: 'Copilot',
  panelTitle: 'Copilot',
  iconName: 'jupyterlab_ai_code_assistants_extension:copilot',
  iconSvg: copilotSvgStr,
  cliBinary: 'copilot',
  // No fork flag exists, so the server copies the session directory under a
  // fresh id and the launch resumes that id like any other session.
  forkStrategy: 'server-copy',
  colourSource: 'none',
  // The name is `name` in the session's workspace.yaml, which `/resume` shows.
  canRename: true,
  // `--session-id <uuid>` starts a session under an id we mint.
  mintsNewSessionId: true,
  launchModes: [
    {
      id: YOLO_MODE,
      title: 'YOLO mode',
      description:
        'Launch new and resumed sessions with `--yolo`; tool calls, paths and URLs are allowed unasked.',
      default: false,
      menuLabel: 'YOLO'
    }
  ],
  hasRemoteControl: false,
  hasBgAgents: false,
  hasLiveProcess: false
};
