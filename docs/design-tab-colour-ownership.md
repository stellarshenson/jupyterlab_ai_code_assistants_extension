# Tab Colour Ownership Design

A terminal tab's colour is owned by exactly one extension, and the owner persists it against a durable identity. Replaces the arrangement where this extension read `jupyterlab_colourful_tab_extension`'s browser storage to discover what the user had picked. Spans two repositories: `jupyterlab_colourful_tab_extension` (the companion, which owns the tab CSS and the right-click menu) and this one.

## The defect this removes

Observed 2026-09-04 on a Claude conversation in `jupyterlab_advanced_markdown_viewer_extension`: the tab rendered green, four `/color orange` commands changed nothing, and only a colour picked on the tab itself took effect.

- **Terminal names are slots, not identities** - terminado's `_next_available_name` returns the lowest unused integer, so a closed terminal's name is handed to the next one created
- **The companion persists under the slot** - `terminal:<name>` in `localStorage`, so the colour of a dead terminal paints the terminal that inherits its name
- **The prune cannot close it** - `deadTerminalIds` drops stored ids ABSENT from the server's running list; a recycled name is present, so the entry survives every prune. Timing is irrelevant, the rule itself cannot see the substitution
- **This extension promoted the stale colour** - `reconcileColours` read that entry and wrote it into the per-conversation store as HAND-SET, the top rung of the ladder, which then outranked the conversation's own `/color` for good
- **Damage was durable** - a scraped false positive became a server-side override with no affordance pointing at it, because the release menu offers only colours the user is recorded as having chosen

## Mechanism

Three changes, each removing one link of the chain above.

- **Capture is an event, not a scrape** - the companion emits `colourChanged` when the user picks a colour or clears one; this extension listens. A stored value can no longer be mistaken for a choice, because only a click produces the signal
- **Ownership is declared** - `claim(widget)` tells the companion that another extension persists this tab's colour. A claimed tab is never written to `localStorage`, and is repainted from it only while its incarnation fingerprint still matches, so the two stores stop competing for one tab
- **A terminal colour carries an incarnation fingerprint** - the companion's new server route reports each terminal's pty process identity; a stored colour whose fingerprint no longer matches is dropped. A recycled name loses its colour before it can paint

## Companion API

`IColourfulTabs` gains two members. `setColour` is unchanged.

- **`colourChanged: ISignal<IColourfulTabs, IColourChoice>`** - emitted on every menu pick and every clear, with `{ widgetId, colourId }`; `colourId` is null for a clear. Carries the colour ID string, not the palette index, so the companion can reorder or rename its palette without breaking a consumer
- **`claim(widget): IDisposable`** - marks the widget's tab externally owned. Claiming suppresses exactly one thing, PERSISTENCE: a menu pick on a claimed tab paints and is announced, but is not written to `localStorage`, because the owner writes it against a durable identity instead. A pick or a clear on a claimed tab does DELETE any entry already stored for it, because the user has just replaced the choice that entry recorded - keeping it would let it repaint over the newer pick in the window before the owner has filed it. Reference counted, so one holder's dispose cannot release another's
- **Repainting a claimed tab** - the companion still restores a stored colour onto a tab carrying no colour class, which is the guard it already had and which can only fire when the owner has painted nothing. That is what lets a terminal coloured before the assistant started keep its colour, with no transfer of ownership and no second copy. On a CLAIMED tab it restores only a FINGERPRINT-VERIFIED entry: an unverified one is exactly what a recycled name leaves behind, and painting it onto an assistant's tab is the original defect returning by its visual half
- **The claim does NOT hand the colour over.** An earlier revision had the companion announce the stored colour at claim time so the owner could adopt it. That is wrong and it was removed: a claim episode ends and restarts as ordinary business - a reload, a failed probe, an assistant restart - so every restart re-filed the dormant colour as a hand-set choice over whatever the user had picked since. A stored colour re-asserting itself over the user's real intent is `DEF-COLO-155`'s exact shape, and reintroducing it one layer up would have been the same defect with a better excuse
- **Version floor** - this extension requires the companion at the version that first ships both members, and feature-detects them at runtime. That version is 1.1.20, named by the manifest floors in `package.json` (`^1.1.20`) and `pyproject.toml` (`>=1.1.20`), so a fresh install cannot arrive without the API. The runtime probe stays as well, because a floor binds only the install - an operator can downgrade the companion afterwards, and the extension has to answer for that. Against an older companion this extension tints NOTHING and says so once: it cannot capture what the user picks, and painting a colour it cannot capture would repaint over that pick on the next pass, which is worse than the defect being fixed. Leaving the tabs alone means the companion behaves exactly as it did before this extension was installed

## Companion server extension

New, minimal, and the only way a browser can tell one terminal incarnation from another: the terminal model returned by `GET /api/terminals` carries `name` and `last_activity` only, and `last_activity` moves forward for a reused name exactly as it does for a busy one.

- **`GET /colourful-tab/terminals`** - answers `{"terminals": {"<name>": "<fingerprint>"}}`
- **Fingerprint** - the pty process's pid paired with its start time read from `/proc/<pid>/stat` field 22, so a pid reused by the operating system is still a different fingerprint. Sourced from `terminal_manager.terminals[name].ptyproc.pid`
- **Never get-or-create** - the manager's registry is read directly; `get_terminal` would spawn a terminal for an unknown name and break `GET /api/terminals` for every client (the same trap as `DEF-32` in this repository)
- **Absent server** - the route unreachable means no fingerprints, and the companion then keeps the prune it has today rather than dropping every stored colour

## Persisted shape

- **File tabs are unchanged** - a path is a real identity, so those entries stay `{ path: index }`
- **Terminal tabs gain the fingerprint** - `{ "terminal:3": { "colour": 2, "fp": "8123:874512" } }`
- **Entries with no fingerprint are dropped by the first fingerprinted prune** - the legacy shape cannot be told apart from the stale entry this design exists to remove, and adopting the live fingerprint would have preserved exactly the wrong colour in the observed defect. The loss is one-time for colours set before the upgrade, but the rule is not limited to those: a colour set while the route is unreachable is equally unverifiable and goes the same way. A pick reads its fingerprint out of the map the prune already keeps, which is refreshed at activation and on every change to the running set, so a terminal is in it well before its tab can be right-clicked. Nothing is fetched on the click. An earlier revision fetched one when the map did not hold the name, and the ordering rules that made that fetch safe - an in-flight exemption for the prune, a counter ranking overlapping answers - were more machinery than the window justified, and produced two defects of their own
- **Checked at activation and on every `runningChanged`** - the activation check is new; today the prune runs only on later changes

## This extension

The capture path shrinks to a signal handler; the paint path is unchanged.

- **The new members are typed structurally, not imported** - `node_modules` carries the PUBLISHED companion typings (1.1.16), which do not declare `colourChanged` or `claim`, and this repository has to keep compiling against them. `src/core/types.ts` describes the two members itself and the injected token is narrowed at runtime. The narrowed handle is the only handle this extension keeps, so `setColour` cannot be reached without `claim` and `colourChanged` - which is what makes the older-companion path a single early return rather than a branch at every call site
- **`readUserSetTabColour` is removed** from `src/core/colour.ts`, with the `TAB_COLOUR_STORAGE_KEY` constant and the comment declaring `TAB_COLOUR_IDS`'s order load-bearing. The order is still meaningful for `fnv1aColour`, but no longer coupled to another extension's storage schema
- **`reconcileColours` loses the capture block** in `src/core/terminals.ts` - the `held` gate and the `_applyColour(widget, null)` strip that kept a companion colour visible until a write confirmed both existed to serve the scrape
- **Claim on recognition** - a terminal that probes as this provider's is claimed; the claim is released when the terminal stops being this provider's, when its widget goes, when tab colouring is switched off, and on dispose
- **On `colourChanged`** - resolve the widget to its conversation through the existing probe, then `ColourStore.set(sessionId, colourId)` for a pick and `forget([sessionId])` for a clear, then reconcile. A widget that resolves to no conversation is ignored: a colour is never filed against a conversation guessed from a folder
- **A choice the probe cannot yet resolve is held and re-attempted on the next reconcile pass**, and the terminal is not painted over while its choice is pending. The signal fires once, so without this a colour picked in the seconds before the CLI writes its conversation would be dropped and then painted over. It rides the pass that already runs - no timer of its own. Held only when the probe POSITIVELY answers "this provider's terminal, conversation not readable yet"; a probe that failed says nothing about whose terminal it is, and remembering a choice on that basis files the user's colour against whatever conversation the terminal later turns out to run
- **The ladder is unchanged** - user-set over native over derived over none, and a hand-set colour still outranks `/color` by design. What changes is that only a real choice can reach the top rung

## Edge cases

- **Colour set while the panel is closed** - the signal is emitted by the companion regardless of panel state, and this extension subscribes at plugin activation, not at panel construction
- **Two browser tabs open** - each page captures its own clicks; the store is server-side, so the other page picks the colour up on its next poll
- **Terminal not yet probed when the colour is picked** - the handler probes on demand, so a colour set on a terminal this extension has not yet enumerated still resolves
- **Assistant started in an already-coloured terminal** - the colour stays, as long as its fingerprint still matches the terminal's live incarnation. The owner paints nothing for a conversation it holds no colour for, which for a `none`-source provider (Codex, Gemini) is the ordinary case, and the tab then carries no colour class - which with a matching fingerprint is the condition on which the companion restores its own stored colour. The user's earlier choice shows until they pick a new one, and the new one wins from then on because the owner does hold that
- **Companion server extension disabled** - fingerprints are unavailable and the companion falls back to the running-list prune. This extension's own colours are unaffected, because assistant tabs are claimed and never persisted there. The bullet above does change: with no fingerprints no entry can be verified, so a claimed tab is not repainted from storage at all and a colour set before the assistant started does not survive it. That is the deliberate trade - the alternative is painting an unverifiable entry onto an assistant's tab, which is this defect's visual half, and an unverifiable entry is exactly what a recycled name leaves behind

## Tests

- **Companion jest** - the fingerprint prune (matching, mismatching, missing), the claim lifecycle, the signal payload on pick and on clear, and the legacy-shape drop
- **Companion pytest** - the route against a fake terminal manager: fingerprint shape, unknown name absent from the answer, a manager with no `terminals` registry
- **This extension's jest** - the signal handler across pick, clear, unresolvable widget and failed write; that nothing is painted when the ownership API is absent; and one negative assertion that the paint pass reads no browser storage at all, which is the invariant a future edit would silently undo
- **No end-to-end test crosses the two extensions** - both sides are covered against the contract with the other side mocked, so a contract that drifts on one side alone would pass both suites. Closing it needs both wheels installed into the `ui-tests` environment; logged on the defect ledger as a coverage gap rather than left unstated
