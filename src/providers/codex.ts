// The Codex provider: OpenAI's `codex` CLI.
//
// Ported from `jupyterlab_codex_extension` v0.6.12. Almost everything that
// extension did by hand is now shared panel behaviour, so what is left here is
// the descriptor plus the two tooltip lines Codex has and the others do not.
//
// The three divergences that matter are capability flags, not code:
//
// * `forkStrategy: 'native-command'` - `codex fork <parent>` mints the fork's
//   id itself, so the panel snapshots the branch list, launches, and diffs to
//   discover the id (the shared 2s x 90 discovery watcher)
// * `colourSource: 'none'` - Codex has no colour concept at all, so a tab tint
//   only ever comes from the extension's own write-back store
// * `hasLiveProcess: true` - a project row shows a dot when a `codex` process
//   is running in it, which is the only liveness signal Codex exposes

import {
  IHookContext,
  IProviderDescriptor,
  IProviderHooks
} from '../core/types';

// The OpenAI "blossom" mark - Codex is OpenAI's CLI, so the panel wears its
// vendor's logo. Single path, `jp-icon3` so it picks up the theme's foreground
// in both light and dark. The box stays 16px like every other icon; the mark is
// scaled down INSIDE it by padding the viewBox (24 units of art in a 30-unit
// window, so ~80%), which keeps the sidebar tab and header alignment identical
// while the dense logo reads less heavy than the simpler glyphs around it.
const codexSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 30 30" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073ZM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494ZM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646ZM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872Zm16.597 3.858-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667Zm2.01-3.024-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66Zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681ZM9.409 12l2.602-1.504L14.618 12v3.008l-2.597 1.5-2.607-1.5Z"/>
</svg>`;

// Codex's own name for its unsafe switch. Kept in the assistant's terminology
// rather than normalised, because it is both the settings key under
// `providers.codex.` and the mode token the server maps to the CLI flag
// `--dangerously-bypass-approvals-and-sandbox`.
const BYPASS_MODE = 'dangerouslyBypassApprovalsAndSandbox';

export const descriptor: IProviderDescriptor = {
  id: 'codex',
  label: 'Codex',
  panelTitle: 'Codex Sessions',
  iconName: 'jupyterlab_ai_code_assistants_extension:codex',
  iconSvg: codexSvgStr,
  cliBinary: 'codex',
  // `codex fork <parent>` owns both the verb and the new id.
  forkStrategy: 'native-command',
  // No `/color` equivalent, and nothing in the thread store records one.
  colourSource: 'none',
  // Forks are unnamed - Codex has no naming flag and no writable title field,
  // so the panel never asks for a name it could not stamp anywhere.
  namingStrategy: 'none',
  // A bare `codex` mints its own thread id; there is no `--session-id`.
  mintsNewSessionId: false,
  launchModes: [
    {
      id: BYPASS_MODE,
      title: 'Bypass Codex approvals and sandbox',
      description:
        'When enabled, newly spawned and resumed sessions are launched with `--dangerously-bypass-approvals-and-sandbox`. Bypasses every Codex approval prompt and sandbox - only enable in environments you trust.',
      kind: 'boolean',
      default: false,
      menuLabel: 'Bypass Approvals'
    }
  ],
  hasRemoteControl: false,
  hasBgAgents: false,
  // A `codex` process running in the project folder is the only liveness
  // signal Codex exposes - it keeps no per-pid session record.
  hasLiveProcess: true,
  // Retired standalone extension this provider replaces.
  legacyPluginId: 'jupyterlab_codex_extension'
};

export const hooks: IProviderHooks = {
  // Codex's thread store records the model and the token spend of every
  // conversation; no other assistant here does, so they are a provider line
  // rather than a core one.
  tooltipLines: ({ session }: IHookContext): string[] => {
    const lines: string[] = [];
    if (session.model) {
      lines.push(`Model: ${session.model}`);
    }
    if ((session.tokens_used ?? 0) > 0) {
      lines.push(`Tokens: ${session.tokens_used}`);
    }
    return lines;
  }
};
