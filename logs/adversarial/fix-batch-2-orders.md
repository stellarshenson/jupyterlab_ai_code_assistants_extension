# Fix batch 2 - triaged orders from bug-hunter + architect round 1

Source reports: `bug-hunter-round1.txt`, `architect-round1.txt` (this directory). Apply AFTER the UX
batch (same files). Every remedy already shrunk by triage - do not widen. Grep-verify every
"zero-implementor" deletion claim before deleting; a seam with a real user stays, with a note.

## From bug-hunter (all 7 confirmed)

1. [MAJOR] Gemini process identity: per-store `owns_pid(pid)` hook on the store contract, default =
   comm match (current behaviour); gemini overrides to ALSO require `gemini` in `/proc/<pid>/cmdline`.
   `_tree_assistant` (core/routes.py:134-148) calls it. Kills the node-MainThread collision for the
   probe, the colour loop and the write-back. Add pytest: a fake node pid with non-gemini cmdline is
   not claimed; one with the gemini bundle path is.
2. [MINOR] Pin-clear on new session: core/routes.py clears the pin on ANY new-session launch
   (`session_id is None and fork_from is None`), not only when new_session_id present. Pytest: kimi
   pin written by switch is cleared by a plain new-session launch.
3. [MINOR] Colour cleanup only for actually-removed ids: delete_branches/remove report which ids were
   removed; drop_colours receives exactly those. Frontend mirrors (panel.ts:651, :1039) follow the
   response rather than the request where the response names survivors.
4. [MINOR] Migration ordering: src/index.ts skips the migrate POST when the settings registry failed
   to load (settings null), so the marker cannot commit before the settings half can land.
5. [MINOR] Trash honesty: when the client asked for trash and send2trash fails, the item FAILS
   (counted per item 6 below) - core/store.py dispose_path never silently escalates to permanent.
   Declare send2trash in pyproject [project] dependencies.
6. [MINOR] Claude stat race: wrap per-file stat in the OSError-tolerant pattern kimi/gemini already
   use (claude.py:577, :608, :717, :783).
7. [MINOR] Client inherit gate: _colours.inherit is a no-op for colourSource 'native' (the server
   refuses the write anyway) - gate at the call sites or inside ColourStore.inherit.

## From architect (19; rulings)

A1. [MAJOR] include_bg -> include_extras in panel.ts:1056; then grep: if claude's branchQuery hook
only re-sends that param, delete the hook and the branchQuery seam (types.ts:315).
A2. [MAJOR] = bug-hunter 1 (owns_pid). One implementation, not two.
A3. [MAJOR] Colour recompute: stores emit `colour` (British) directly; _effective_colour uses the
row's own value as the native default; DELETE the per-row `default_colour` glob (claude.py:1044-1054
class of work). O(N), spelling uniform end to end.
A4. [MAJOR] Delete the dead `scope:"parallel"` branch (routes.py:347-352), `SessionStore.cleanup()`
and all four overrides + their tests - grep first that no client sends `scope`.
A5. [MAJOR] Delete never-emitted wire fields: IRemoveResponse.removed, IDisposalReport.failed_count,
IForkResponse.forked_from - UNLESS item 3 above starts emitting removed ids; reconcile: the
removed-ids response from item 3 becomes the one real shape; the rest goes.
A6. [MAJOR] Native-flag server fork is dead: drop 'native-flag' from SERVER_MINTED_FORKS, delete
ClaudeStore.fork, fix the registry comment, and guard BranchHandler's inherit_colour with the
same native refusal ColoursHandler has.
A7. [MAJOR] Zero-implementor seams - GREP EACH, delete only proven-unused: rowBadges (check claude's
bg chip path first!), menuItems + IMenuContribution + SHARED_ICONS, derivedColour, launchExtras,
python on_launched, Capabilities.has_remote_control (check the panel's remote-control dot reads
the SESSION field, not the capability - if the capability gates the dot anywhere, it stays).
A8. [MAJOR] Disposal discipline: unify all four stores on gemini's per-item try+count; logger
getLogger(**name**) in claude/kimi/gemini provider modules; per-item failures logged.
(Implements bug-hunter 3+5 counting.)
A9. [MAJOR->resolved] Popup delete confirm: ALREADY resolved in the UX batch (conditional two-step
arming when delete_to_trash is false). No further change.
A10.[MINOR] Fold duplicated helpers into core/store.py: flag-value parser (x3), _git_branch (x2),
_now_iso_z (x2), _process_comm (x2). Keep signatures.
A11.[MINOR] LegacySource.state_file: one convention - literal home-relative string expanded at use;
claude's honours CLAUDE_CONFIG_DIR like the rest of its store.
A12.[MINOR] Kimi mode token: named constant, both sites.
A13.[MINOR] Delete the routes.py shim IF **init**.py imports core.routes directly (verify).
A14.[MINOR] generate-schema.mjs asserts module count == barrel export count (guards barrel drift).
A15.[MINOR] Delete GeminiStore.**init**(root) dead knob; leave kimi's (test-used).
A16.[MINOR] Gemini parse_session_id: confine the /proc-advertised --session-file path under root/tmp
before reading (resolve().relative_to()).
A17.[MINOR] Export one LOG_PREFIX constant; registry.ts and panel.ts import it.
A18.[MINOR] approvalMode description reword in gemini.ts descriptor (regenerate schema via the build
chain): passed when set to a non-default value and no boolean mode overrides it.
A19.[MINOR] Template leftovers: delete the 1+1 scaffold spec; remove @types/react,
@types/react-addons-linked-state-mixin, yjs devDeps (KEEP the lib0 and webpack resolutions and
verify a full make install afterwards - if the build breaks, restore and note).

## Finish bar

make install exit 0, make test exit 0, jlpm lint no NEW errors, then run the Galata suite
(ui-tests, force-reinstall the wheel into .venv first) - all 16+ green. Update docs/defects.md via
the defects.py CLI: DEF entries for bug-hunter findings 1 (register as DEF-11 if not present) are
NOT pre-registered - register-and-close each applied fix with a dated note, category per area.
Do not touch acc-crit (main session owns it). Return: files changed, deletion line count, test
counts, any deletion claim that failed grep verification (kept, with the user found).
