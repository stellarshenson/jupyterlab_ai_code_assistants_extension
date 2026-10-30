# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## [Unreleased]

### Changed

- The Clean Up Parallel Sessions confirmation names every conversation it removes by short id and states their disposal, removed with the trash and deleted permanently without it; the caution line is gone and the warning names the current session

### Fixed

- The Clean Up Parallel Sessions confirmation announces its list of removed conversations by short id to screen readers

## [1.2.294] - 2026-10-29

### Changed

- The Clean Up Parallel Sessions confirmation arms Remove when it warns that a parallel conversation was active after the one kept: the first activation reads Confirm remove and the second removes, an armed button returns to Remove after four seconds, and the second click of a double-click is ignored
- The confirmation that removes a project's history states its consequence in two short lines, the project and the trash outcome in the body and a refused move deleting permanently on its own caution line, and the Manage Sessions delete tooltip drops from 23 words to 11

### Fixed

- A held Enter on the Clean Up confirmation's Remove button no longer confirms it: the key's auto-repeat is ignored, so one press arms Remove and a fresh press confirms

## [1.2.288] - 2026-10-28

### Added

- The `jupyterlab-ai-code-assistants` command lists the sessions of every assistant and renames, moves, deletes, branches and makes current a session through the running JupyterLab server, which it finds with its token when run without arguments; a moved Codex session is forked into the target project and its source archived, so its id changes and the command prints the new one
- `jupyterlab-ai-code-assistants refresh` re-checks which assistant CLIs are installed and updates every open JupyterLab window without a browser reload: the panel of a newly installed assistant appears and the panel of a removed one goes away
- A session change, made with the command or in a panel, shows at once in that assistant's panel in every open window on the server, instead of after the panel's next 30-second list refresh

### Changed

- Each panel's header and sidebar tab name the assistant alone (Claude Code, Codex, Kimi Code, Gemini, DeepSeek) without the word Sessions, and the settings describe the panels the same way; the Refresh command keeps its label, such as Refresh Claude Code Sessions
- The check of which assistant CLIs are installed no longer repeats every 60 seconds: it runs when the page loads, when the browser tab becomes visible, when the network comes back and when the server pushes the result of `refresh`, and checks that coincide share one probe on the server
- Deleting sessions keeps a conversation that a running terminal is on for every assistant and for the command alike, and the panel says how many it kept; before, only Claude Code kept it

### Fixed

- In a Claude Code project whose folder name holds a space, an @ or another character that is not a letter or a digit, the panel reads the directory Claude Code itself keeps for that folder, so the conversation a running terminal is on is recognised there as in any other project, and a session moved into such a folder lands where Claude Code resumes it
- The same holds for a Claude Code project folder whose name holds an emoji or whose path is longer than 200 characters: a moved session lands in the directory Claude Code itself names for that folder, and the project is listed under its own folder when the last turn ran in a subfolder
- After a Codex terminal closes, the project row no longer shows the dot 'A Codex session is active in this project': the background Codex app-server, which keeps running in that folder, no longer counts as a Codex session
- Adding or removing a favorite star draws the panel's rows once, so the row a following click is aimed at is no longer replaced under it; the window that made a session change reads the sessions once, and every other open window still shows the change at once

## [1.2.282] - 2026-10-25

### Changed

- The Clean Up Parallel Sessions confirmation shows a warning box when a parallel conversation it removes was active after the conversation it keeps, and states its hint in one short sentence of at most twelve words

### Fixed

- The live-conversation rule, and Clean Up's protection of the conversation a running terminal is on, now hold on every operating system, not only on Linux: where the process identity cannot be read, the live process id alone decides, as it did before the identity guard
- The Clean Up Parallel Sessions confirmation carries an accessible name that follows its question, and its warning about a newer parallel conversation is announced when it appears
- The Clean Up Parallel Sessions confirmation states that a refused trash move deletes permanently, instead of promising the trash with no mention of the permanent removal
- The Clean Up Parallel Sessions confirmation says that nothing is left to clean up and refreshes the row when a second client has already cleaned the project, instead of disappearing with no message on a stale list; the outcome dialog is named and its message is announced

## [1.2.271] - 2026-10-25

### Changed

- The two entries of a session row's context menu that delete history, Clean Up Parallel Sessions and Remove from followed by the assistant's name, show their label and their icon in JupyterLab's error colour (red) in the light and the dark theme, also under the pointer or the keyboard; their background while under the pointer or the keyboard stays the one every other entry has
- Copy Path and Copy Session ID in a session row's context menu show JupyterLab's copy icon
- The shipped session-operations skill's pin and resume steps rank a project's transcripts the way plain `claude -c` does, including the thirty-day rule for a transcript whose file date sits in the future

### Fixed

- Coming back online, or the JupyterLab tab becoming visible, while JupyterLab is still starting now re-checks which assistants are installed once the extension has started, instead of waiting up to a minute; assistants turned off in the settings are not shown in the meantime
- A colour file written before origins or write times were recorded keeps its colours when the assistant's own colour disagrees, because the file cannot tell a hand pick from an inherited colour; a colour the assistant records for a /clear replacement still wins over an inherited copy
- The extension sets the file date of a new Claude Code branch to the moment it is created, so a branch of a conversation made current with Switch no longer takes the parent's thirty-day stamp and is no longer moved back to the moment of the parent's switch, whichever way Claude Code writes the branch's file
- A row click or a Branch Session click no longer reuses a running terminal that has moved to another conversation: the clicked conversation opens in its own terminal, instead of the one the terminal runs
- Removing a session no longer brings its row back when a listing requested before the removal answers afterwards
- A conversation created after a pin now supersedes the pin for Clean Up and for plain `claude -c`, instead of the two following the pinned conversation
- After Branch Session, pressing + before the branch has finished opening no longer clears the pin that makes plain `claude -c` resume the branch

## [1.2.236] - 2026-10-21

### Changed

- Requires JupyterLab 4.6 or later: the extension's `@jupyterlab` dependencies are declared at `^4.6.0`, except `@jupyterlab/coreutils` at `^6.6.0` and `@jupyterlab/services` at `^7.6.0`, their versions in JupyterLab 4.6, so JupyterLab 4.5 or older lists the extension as incompatible and warns about it

### Fixed

- A second click on a session row whose hidden open is still running gives the terminal the keyboard when that click's own dialog closes, and leaves it behind the current tab when that dialog is hidden; if the first open fails, the second click opens the conversation itself
- The second click of the double-click that raised the spinner dialog no longer presses Hide when Hide is under the pointer; a click on Hide more than 600 ms after the dialog appeared hides it whatever the operating system counts it as
- After Hide on one open and a click on another session, the file browser ends on the folder of the newer click, whichever open finishes last
- The session list no longer goes back to an older state when an earlier listing request answers after a later one
- A panel click (a row, +, Branch Session) made while a Launcher tile launch of any assistant is still running, and a Launcher tile click made while a tile launch or a launch from the same assistant's panel is still running, run in click order: the newest click's terminal is the one shown last, and a resume no longer starts a second process on a conversation the other click is opening
- A click on a session row opens it even when a list refresh redraws the rows between the press and the release of the mouse button; it used to do nothing
- Holding Enter or Space on a session row no longer hides the spinner dialog through the key's repeats; a separate press on Hide still hides it
- Hide on the spinner dialog acts when the mouse button or Space is pressed on it, as Enter already did: a press on Hide released after the action completed leaves the terminal behind the current tab; it used to put the terminal in front with the keyboard
- A click on a session row, and Enter or Space on it, makes that conversation the project's current one, so plain `claude -c` in the project resumes the clicked session; a click that reuses a running terminal makes it current too, while a launch from a context menu still only opens it
- A row clicked while an earlier switch for the same project is still in flight is the conversation plain `claude -c` resumes: the panel sends each project's switch requests in click order, one after the other, so an earlier write that the server answers later can no longer land last

## [1.2.199] - 2026-10-20

### Changed

- The assistant icons in the Launcher's AI Assistants tiles are drawn at three quarters of the size of JupyterLab's own tile icons, centred in the tile; the section header icon, the sidebar tabs, the panel header and the menus keep their size
- A button in the extension's dialogs shows JupyterLab's focus outline when the keyboard moved the focus to it; a button clicked with the mouse, or focused by a dialog opened with the mouse, still shows none

### Fixed

- After Hide on the spinner dialog, the action's terminal is a tab behind the current one, whether it opens later or had already opened behind the dialog: the current tab and the keyboard focus stay where the user is, in a notebook cell being edited too, so keys typed elsewhere no longer reach the assistant's prompt
- In Manage Sessions, a confirming click on Delete more than 600 ms after arming it deletes, even when the operating system counts it as the second click of a double-click; one double-click on Delete still only arms it
- Branch Session on a Claude Code row branches a conversation whose last turn ran in a subfolder of the project or before the folder was renamed; it reported "Claude Code cannot branch this conversation."
- When the terminal of a newly created branch fails to open, the panel no longer reports that the conversation cannot be branched, and the new branch appears in the list
- A double-click on a session row no longer closes the spinner dialog: the second click landed on the dialog's backdrop; the dialog now closes only through Hide, not through its backdrop or Escape

## [1.2.163] - 2026-10-20

### Added

- The shipped agent skill carries two new references: `claude-operations.md` (how `claude -c` and `--resume` choose a session, the causes of "No conversation found to continue", repairing a compacted conversation, promoting a background job, re-homed transcripts, pins and transcript clean-up) and `cross-assistant-sessions.md` (the stores, transcript formats and resume commands of Claude Code, Codex, Kimi, Gemini and DeepSeek, an inventory of a project's sessions across all five, newest first, and a takeover procedure); it no longer points at skills outside the wheel for Claude Code mechanics and takeover

### Changed

- A row click and a Branch Session click raise the launch spinner dialog instead of a busy card of their own; the launch that follows keeps the same dialog, so one spinner stays on screen from the click to the terminal, names the newest action still running, and closes before the terminal takes the keyboard
- The spinner dialog names the assistant session - "Branching Claude Code session", "Opening Claude Code" - and is compact: a semi-bold title one step above the base UI size, a 240px minimum width, a 24px ring and a 28px Hide button; it never shows a scrollbar beside the turning ring; a screen reader hears the title when Hide takes the focus
- No button in the extension's dialogs shows a focus rim; the primary action is marked by its fill, and the secondary buttons - Cancel, and Close in the Open Callback popup - have a border instead of a grey fill

### Fixed

- The five assistant icons (Claude Code, Codex, DeepSeek, Gemini, Kimi) now render at the size of JupyterLab's own icons in the Launcher, the sidebar tabs and the menus; the Gemini, DeepSeek and Kimi icons no longer fill their Launcher cards
- The AI Code Assistants settings form no longer ends with an Add item control; a key it saved stays in the settings file and changes nothing
- Clicking a Gemini conversation resumes it in place with `gemini --resume <id>`, so its new turns land in its own chat file; on gemini-cli 0.64.0 the old `--session-file` launch started a copy under a new id each time. A Gemini row's message count no longer counts a tool turn twice, and an unnamed conversation is labelled by the first prompt the user typed instead of the CLI's `<session_context>` block
- The shipped agent skill now states that `claude -c` falls back past a transcript it refuses, such as a compacted root, where it said `-c` had no fallback; its DeepSeek steps save the `claude-deepseek` wrapper on `PATH` instead of naming a launcher path that a plain install does not have

## [1.2.123] - 2026-10-19

### Fixed

- The Manage Sessions popup now follows the submenu that opened it: Switch and Manage Sessions offers Switch per row and makes that conversation current, Open Branched Conversation offers Open and launches it, and the current row no longer shows a Switch button

## [1.2.120] - 2026-10-19

### Changed

- The spinners always animate, regardless of the operating system's reduced-motion setting; the click-time busy overlay still names the action in a visible label

## [1.2.118] - 2026-10-18

### Added

- A Claude Code conversation cleared with `/clear` keeps its tab colour: the replacement conversation inherits the effective colour of the conversation it replaced, whether the colour was set by hand on the tab or chosen by the assistant, and the entry is recorded as inherited rather than as a hand-set override

## [1.2.115] - 2026-10-18

### Added

- The wheel ships the session-operations agent skill at `share/jupyter/agents/skills/jupyterlab-ai-code-assistants-extension`: finding, moving, splitting, renaming, copying and promoting Claude Code sessions, the task-list environment variables, and Kimi K3 and DeepSeek launchers; the README shows the wheel and clone installs

### Changed

- A row click and a Branch Session click raise the busy overlay on the lab shell over the main working area; the visible label and the screen-reader live region name the action still running, and both follow overlapping actions
- Under `prefers-reduced-motion: reduce` the busy ring holds still at full opacity and the visible label names the action
- Every Manage Sessions delete arms first, including the trash path, and completion reads "N deleted"
- Session deletion moves conversations to the trash when JupyterLab's setting is on and the system accepts the move; a refused move may remove them permanently or leave them in place, and the server log carries a warning
- A re-homed conversation reuses a terminal only when that terminal's working directory sits inside the clicked project

### Fixed

- The click-time busy state covers the main area instead of sitting inside the assistant panel
- A successful conversation switch no longer raises a toast
- Conversations whose first turn follows a large metadata prefix are no longer hidden as metadata-only transcripts
- The extra-conversation count no longer undercounts when the pinned current conversation is metadata-only
- The fresh-id copy tool rewrites `sessionId` and `session_id` at any depth in the transcript and side files, and a failed copy leaves no partial output
- The runbook states that `.pinned-session` is read by `claude-here` only, that the panel keeps its own pin, and that a copy resumes with `claude --resume <new-id>` or `claude-here`

## [1.2.105] - 2026-10-17

### Changed

- A successful conversation switch no longer raises a toast. The row's own update is the signal, and the warning for a switch the store refuses stays

### Fixed

- The click-time spinner for a row click and a Branch Session click now covers the main working area, centred on the lab shell, instead of sitting inside the assistant panel
- A re-homed conversation reuses a terminal only when that terminal's working directory sits inside the clicked project; otherwise the click opens a terminal in the clicked folder
- A real conversation whose first turn follows more than 256 KiB of file-history snapshots is no longer hidden as a metadata-only transcript
- A project whose current conversation is a metadata-only transcript counts its other conversations correctly instead of one short

<!-- <END NEW CHANGELOG ENTRY> -->

## [1.2.99] - 2026-10-17

### Fixed

- A Branch Session click or a row click raises the panel's spinner at once and keeps it until the terminal opens, instead of staying silent while the extension decides

## [1.2.83] - 2026-10-16

### Changed

- The DeepSeek panel opens conversations in the terminal instead of the harness's browser UI. A row click resumes that row's conversation with `dsh tui --resume <id>` in a terminal, and the open verb reads `Resume`, no longer `Open Web UI`; a new session runs `dsh tui` and starts a conversation whose id the TUI mints itself. Each conversation opens in its own terminal, where one terminal used to serve every conversation of the project. Requires the community TUI bundle (`@deepseek-harness-tui/dsh-tui`), mounted as the `tui` profile with `dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui`
- A DeepSeek launch without the TUI bundle is refused before any terminal opens, with a message naming the bundle and the command that mounts it
- DeepSeek panel icon replaced with the official DeepSeek whale mark, rendered monochrome in the theme foreground
- Codex conversations can be renamed from the panel. The name is written through Codex's own app-server, so Codex's CLI lists the same name the panel shows; the Rename item was previously absent for Codex
- Branching a named conversation names the branch after its parent with the next free number, `analysis_1` then `analysis_2`, without asking for a name, and the branch inherits the parent's tab colour
- A Claude terminal tab follows your newest colour choice. Running `/color` in the conversation after picking a colour on its tab now changes the tab, where the tab pick used to win until `Reset Tab Colour`; a tab pick made after `/color` still stands, also when the conversation is opened again. A `/color` that Claude rejects does not count, and `/color pink` and `/color cyan` show as rose and sky
- The Manage Sessions dialog shows `Delete` in its action row beside `Close`, as an outlined red button that fills red once armed for the second click, instead of as grey text on a row of its own

### Fixed

- The Manage Sessions dialog opens with the keyboard focus in its filter field, so typing filters the list straight away. The focus used to land on `Close`, where typed characters were dropped
- A click on a Codex row whose conversation was started with `+` or branched from the panel focuses its open terminal instead of opening a second one. Codex's own app-server now creates the conversation and its id before the terminal opens

## [1.2.73] - 2026-10-14

### Fixed

- `Claude Code: Dangerously skip permissions` no longer turns itself off. The one-time migration from the retired standalone extensions could run again when a JupyterLab server used the same settings folder but a different data folder, and it then wrote the retired extension's saved value over the value saved in this extension. A migrated setting is now applied only when nothing is saved for it in this extension's settings, for every setting the migration carries over

## [1.2.71] - 2026-10-10

### Added

- The file browser follows the session you open. Opening an existing session from a panel (a row click, Enter or Space on a row, Resume, an `Open Branched Conversation` item, the `Manage Sessions` Open button) moves the JupyterLab file browser to that session's project folder. The file browser tab is not activated and the keyboard focus stays in the terminal. A project folder outside the server root is skipped. When two sessions are opened close together, the file browser ends on the folder of the session opened last
- A new setting, `syncFileBrowser`, turns this on and off for every panel. It is on by default
- A right-click on a panel header opens a menu with the two shared settings changed most often: `Sync File Browser`, checked while it is on, and `Move Panel Left` or `Move Panel Right`, which moves every assistant panel to the other sidebar. The panel that was on screen stays on screen after the move; with one panel on screen in each sidebar, it is the panel whose menu was used

### Changed

- A change of the `sidebar` setting, from `Move Panel` or from the settings page, now also moves a panel that was placed with JupyterLab's own `Switch Sidebar Side`. The new side is saved to JupyterLab's layout setting, so it holds after a page reload. Before, such a panel stayed where JupyterLab had put it
- The browser test helper for `Open Callback` opens the command palette again when another command closed it. One run in 19 had failed at that point. The extension itself is unchanged there
- The project `Makefile` is at version 1.45: `make install` also installs the optional dependency groups of `pyproject.toml`

## [1.2.56] - 2026-10-02

### Changed

- The browser tests for `Open Callback` now run against a fake OpenAI Codex login: a listener that issues a link with a state and a one-time code, redirects the callback to its `/success` address and closes after that request. Four tests deliver links through the popup: the full handshake, the same link sent again, a link from an older login attempt, and a link that is not loopback. The extension itself is unchanged

## [1.2.55] - 2026-10-02

### Changed

- The `Open Callback` popup closes by itself 3 seconds after it has shown the result, after a success and after a failure alike. Close still ends it at once
- One popup sends one link: a second OK in the same popup sends nothing. The login code in a callback link works once, and a second send of the same link fails a login that the first send completed

### Fixed

- `Open Callback` now completes an OpenAI Codex login. Codex saves its tokens on the callback request but ends the login only on the request for the `/success` address it redirects to, so its screen kept waiting. The Jupyter server now follows a redirect when its target is an `http` loopback address, at most 5, and requests no address twice. A redirect to any other address is still not followed, and neither the link nor the redirect address is logged

## [1.2.52] - 2026-10-01

### Fixed

- The title in a panel's header starts on the same left edge as the section labels and the row names, 14px further right than before. It stood on the panel's inset, left of everything below it. In a wide font at the default panel width, "Claude Code Sessions" can now take two lines

## [1.2.50] - 2026-10-01

### Changed

- The `Open Callback` popup has a wide link field, and OK or Enter no longer closes it: the link is sent and the result appears under the field in plain words, for example "The login accepted the link. Check the terminal where the login is running." A refused link can be replaced and sent again in the same popup; Close ends it
- The green status dot on a session row is smaller: its bright centre is 6px where it was 8px, inside the same halo as before. Row names keep their position

## [1.2.47] - 2026-10-01

### Added

- `Open Callback` command, on the command palette under AI Assistants. When an assistant's login sends your browser to an `http://127.0.0.1:...` link that fails to load, because the login is waiting on the machine running JupyterLab, paste the link into the command's popup and the Jupyter server requests it for you. Only `http` links to that machine's own loopback are accepted, redirects are not followed, and the link is never logged

## [1.2.45] - 2026-09-29

### Fixed

- A setting of this extension no longer goes back to an old value when you change any setting in another JupyterLab window that was opened earlier. A change now reaches the other windows of the same browser at once, and a window in another browser or on another device picks up newer settings when it gains focus. This is how the Claude Skip Permissions setting kept turning itself off

## [1.2.41] - 2026-09-28

### Fixed

- An assistant whose command-line tool is not installed no longer raises a warning when JupyterLab loads or settings change, even when its enable setting is saved as on. Enabled means the extension supports the assistant, not that it is installed. Its panel and Launcher tile stay hidden, and the reason is written once to the browser console

## [1.2.38] - 2026-09-28

### Fixed

- Opening a Claude conversation that a running background agent holds, from the panel or the Launcher tile, now stops the agent and resumes the same conversation in your terminal as an ordinary interactive session. Before, the panel attached the terminal to the agent, and the conversation stayed with the agent however long you worked in it. If the stop fails, the panel attaches as before

### Changed

- On a row that a background agent holds, the Resume items read "Stop Background Agent and Resume", the Skip Permissions item with its mode appended, and the row tooltip says the click stops the agent. The launch mode now applies to these rows too, because they are resumed rather than attached to

## [1.2.35] - 2026-09-25

### Changed

- Favourite stars sit in one straight column again, directly before a time column at least 4.5em wide. A time label wider than that, such as "14m ago" in some Linux fonts, grows its own box to the left, so the labels stay right-aligned and only that row's star moves
- Panel content stands 4px from the panel border on both sides instead of 8px: the title, header buttons, search field, error line, section headers and rows share one inset, so names start 18px from the left border and the time column ends 19px from the right
- Build: every `make install` raises the patch version, and `make publish` runs the test suite before it builds. Its authentication check now imports the source being released instead of the previously installed copy

## [1.2.31] - 2026-09-23

### Changed

- The favourite star on a session row sits beside the time-ago label, 6px from it on every row; on a short label such as "now" it stood 32px away. Its left edge now follows the label rather than forming a straight column

### Fixed

- The "11mo ago" label overflowed its fixed-width box and ended 5.8px right of every other label; the label now sizes to its own text, so every label ends on the same line

## [1.2.30] - 2026-09-20

### Added

- Rename Session. A conversation is renamed from the row's context menu, and the name is written where the assistant itself reads it back: Claude gets the record its own `/rename` writes, Kimi a custom title in its session state, Gemini a summary on every record of the chat file, DeepSeek a rewritten title event. The panel shows the name the store actually kept, which a provider may have normalised
- Codex declares no rename, so the menu item is absent for it rather than offering an action that would fail. Its names live in a database this extension opens read-only, and the CLI has no rename verb

### Fixed

- A rename counted as a turn. Claude's thirty-day switch stamp - the mark that decides what `claude -c` resumes - was spent by the write, and a week-idle Kimi, Gemini or DeepSeek row jumped to the top of Recent with a tooltip stating a time the assistant never spoke. Every store now restores the conversation's timestamp after writing the name
- The route-gating test claimed to cover every provider route while checking seven of the ten registered; the list is now read off the route registration, so a route added to the server cannot skip the gate check

### Changed

- Every one of the 181 acceptance criteria now carries a test, and each test has been shown able to fail by severing the behaviour it guards. Three new guard modules cover what had none: the Python core is scanned for assistant names as the TypeScript core already was, the shipped settings schema is held against the provider registry, and the browser-test harness's own configuration is asserted rather than assumed

## [1.2.27] - 2026-09-19

### Changed

- The package description on npm and PyPI now says what the extension does: a launcher and manager for Claude Code, Codex, Kimi, Gemini and DeepSeek sessions, rather than a note about the three extensions it replaced
- The README names JupyterLab 4.6.0 as the required floor, which is the version the extension is built and tested against
- `CONTRIBUTING.md` and `RELEASE.md` describe the Makefile lifecycle - `make install`, `make test`, `make publish` - instead of the raw `pip` and `jlpm` commands this project does not use
- The coloured-tabs setting no longer says the companion extension may be absent; `jupyterlab_colourful_tab_extension` installs with this one

### Fixed

- A Claude Code installed from npm was never recognised as the assistant running in a terminal, because that distribution runs `cli.js` under `node` instead of as a `claude` binary. Its terminal was not reused after a page reload and its tab was left untinted; the terminal is now claimed from the command line as well as from the process name

## [1.2.25] - 2026-09-17

### Added

- DeepSeek joins Claude Code, Codex, Kimi and Gemini as the fifth assistant. Its panel lists the projects under `~/.dsh/sessions` (or `$DSH_HOME`) and a row's `Open Web UI` starts the DeepSeek Harness's browser UI in the project's terminal; branching and deleting work from the panel as for every other assistant. Requires the `zstandard` Python package, which installs with the extension
- A terminal-scope capability on the provider descriptor. An assistant whose one process serves every conversation of a project, as the DeepSeek web UI does, reuses the project's running terminal for every open - row click, `+`, fork, Launcher tile - instead of starting a second server

### Changed

- In the Manage Sessions popup a row click always switches to that conversation; the checkbox is the only control that selects rows for deletion. A click no longer changes meaning once something is selected
- DeepSeek's context menu no longer offers Open Branched Conversation, and its popup Open buttons say `Open Web UI`, since one terminal serves every conversation of the project
- The README states the one case where a click opens a second terminal: a Codex or Kimi conversation started with `+`, and a Codex fork, run without an id until the CLI writes one

### Fixed

- `+` on a DeepSeek project whose web UI was already running left a prior switch's pin in place, so a conversation then created in the browser was not the row's current one. The pin is now cleared without starting a second server
- A DeepSeek web server the user had started by hand and then stopped was focused as a dead shell on every later open; the panel now starts the harness afresh
- The Remove and Clean Up dialogs said "This cannot be undone" also when the deletion went to the trash and was recoverable; the sentence appears only for a permanent deletion
- The inline error strip used a colour token the stock dark theme does not define; it now uses the theme's own error background

## [1.2.18] - 2026-09-07

### Added

- The panel's own text now goes through JupyterLab's translation system, so a translation shipped for the interface language reaches this extension too. Nothing changes for an English interface

### Changed

- Last-activity times in the panel are read from each conversation's own records rather than from its file timestamp, so a row's label stays truthful even when something has touched the file without adding a turn

### Fixed

- The dot marking a live or remote-controlled conversation lost its dark-theme rendering in 1.2.7, drawing a doubled near-black contour instead of a lit green mark. The stylesheet now branches on the theme, so dark is restored exactly as it was before 1.2.7 and light gets a brighter green with a pale green halo, chosen on sight from rendered candidates over a white ring that read as a blob on grey rows. The halo is pale rather than high-contrast by choice: no light halo can reach WCAG 1.4.11's 3:1 against the light row colours, because even pure white on them measures 1.77:1
- Switching to a conversation now holds against a sibling conversation that keeps being written to. `claude -c` resolves a project to its newest transcript by file modification time alone, so the switch's own touch was overtaken within seconds by any other conversation open in a terminal, and the panel and the terminal disagreed about which conversation was current. The switch marks its target far enough ahead that no append overtakes it, and gives that mark back when the panel moves off the conversation
- A conversation moved from another project and then switched to could make the panel report that other project's directory, rename the row to it, open terminals there, and in some cases drop the project from the panel altogether. Where a project lives is now settled from the project's own directory rather than from whichever conversation is current

## [1.2.7] - 2026-09-05

### Fixed

- The green dot marking a live or remote-controlled conversation was tuned for the dark theme and came out near-black on the light one. It is now drawn as an icon whose colour the theme picks, so it reads as a green light on both - a mid green on the light theme and a brighter one on the dark

## [1.2.5] - 2026-09-05

### Changed

- `jupyterlab_colourful_tab_extension` is now required at 1.1.20 or newer (`^1.1.20` in `package.json`, `>=1.1.20` in `pyproject.toml`), which is the release that carries the tab ownership API and the terminal fingerprint route. Until now the requirement named 1.0.19, so a fresh install resolved to a companion without that API and every assistant tab went untinted behind a warning; the floor could not name 1.1.20 before it was published. The runtime check stays in place, because a requirement binds the install and a companion can be downgraded after it

## [1.2.4] - 2026-09-05

### Fixed

- A terminal tab could keep showing a colour that belonged to a conversation which had already ended, and the assistant's own `/color` was then powerless to change it. The server hands a closed terminal's number to the next terminal opened, and a colour stored against that number was read back as a colour you had chosen, which outranks everything the assistant picks. Colours you pick are now learned from the pick itself instead of being read out of the companion extension's browser storage, so a stored value can no longer be mistaken for a choice, and a colour kept against a terminal number survives only while the process behind that number is unchanged
- Clearing a colour from the tab's own right-click menu now releases the colour recorded for that conversation, for a conversation whose terminal is open; before, only `Reset Tab Colour` could undo it

### Changed

- Terminal tab tinting now requires `jupyterlab_colourful_tab_extension` at the release that reports the colours you pick and lets another extension own a tab. Against an older companion this extension tints no tabs at all and says so once, in a notification that stays until dismissed; the companion's own right-click colours are unaffected
- A terminal running an assistant is claimed with the companion, so the companion stores nothing for that tab and the two extensions no longer hold competing records of one tab's colour

### Added

- Design note `docs/design-tab-colour-ownership.md` describing the ownership protocol across the two extensions

## [1.2.1] - 2026-08-28

### Changed

- Version line moved to 1.2 to mark the Launcher tiles as a feature release; the content is that of 1.1.13

## [1.1.13] - 2026-08-28

### Added

- An "AI Assistants" section in the JupyterLab Launcher with one tile per enabled assistant; a click opens that assistant in the file browser's current folder, resuming the folder's conversation when one exists and starting a new one otherwise, in a terminal spawned through `jupyterlab_basic_terminal_extension`
- The section carries the extension's own robot-head icon rather than the first assistant's, sits after Other, and appears or disappears live as assistants are enabled or disabled in settings - no section when none is enabled
- `POST providers/<id>/launch-argv` returns the command line the launch route would spawn, with the same validation and pin bookkeeping
- Design note `docs/design-launcher.md`, kept in step with the implementation

### Changed

- `@jupyterlab/launcher` pinned `^4.6.0` for `categoryRank`; `jupyterlab-basic-terminal-extension>=1.0.7` is a runtime dependency; `react` is a direct dependency for the section-icon view

### Fixed

- `yarn.lock` is back in the berry format the build reads; a yarn v1 shim had rewritten it in the previous commit, and both lockfiles now resolve one tree

## [1.0.41] - 2026-08-27

### Fixed

- A sign-in or proxy page returned with status 200 no longer empties the sidebar - the extension now treats a non-JSON answer as "the server did not answer" and keeps the panels it has, instead of reading it as "no assistant is installed"
- Opening a conversation held by a session record with a zero or negative process id no longer skips the transcript repair and no longer routes the launch to a background agent that does not exist
- Forking a Gemini conversation keeps the chat file byte-faithful - a line-separator character inside a message no longer splits the record, non-ASCII text is no longer re-escaped, and a record that cannot be encoded declines the fork cleanly instead of failing with a server error
- Before the server has answered its first status check, Open Terminal and Show in File Browser now say "Waiting for the server root" instead of blaming a folder outside the JupyterLab root
- Rows drawn before the server root is known now show root-relative paths the moment the root arrives, instead of at the next 30-second refresh
- An assistant that is enabled but not installed now says so in its panel, naming the missing command, instead of "Could not reach the server - retrying"
- The "enabled but its binary was not found" notice can fire again after a false alarm - the once-per-page latch clears as soon as a status check reports the assistant available

### Changed

- The plugin's activation path is now covered by a Jest suite; `jest.config.js` ignores the two virtual environments whose duplicate labextension copies broke module resolution

## [1.0.39] - 2026-08-27

### Fixed

- The sidebar no longer stays collapsed after a reload or a JupyterLab restart whose first status check fails - the extension read "the server did not answer" as "no assistant is installed" and docked nothing, so JupyterLab found no panel to restore and closed the sidebar itself; a failed check now leaves the last known set of panels in place, and until the server has answered once every enabled assistant is docked so the panel you had open comes back where it was
- A panel docked before the server's first answer can no longer start a session in the wrong folder - the new-session button used to join the file browser's folder to an unknown root and could launch at the top of the filesystem
- A panel docked before the server's first answer can no longer delete conversations permanently on one click - the Manage Sessions Delete button now arms first whenever the trash setting is not yet known
- The new-session button is disabled, dimmed and titled "Waiting for the server root" until the server has answered, instead of looking live and doing nothing

### Changed

- Defect and acceptance-criteria tracking moved to the `project-management` schema - every item carries a permanent id (`DEF-GUARD-132`) and an author handle; existing defect numbers are unchanged

## [1.0.32] - 2026-08-26

### Fixed

- Opening or switching to a conversation no longer reads the whole transcript to find there is nothing to repair - measured at 0.8 s and 438 MiB of server memory for a single click on a 100 MB conversation, on the path 91 of 107 conversations take
- A conversation being written to while the panel opens it can no longer lose that turn - the check meant to abort such a rewrite took its reference point after reading the file, so a turn typed during the read was already counted as part of it
- Repairing a compacted conversation no longer rewrites or inflates the rest of the transcript - it grew a 105 MB file to 170 MB by re-encoding every line, where now only the two records the repair touches differ
- A transcript the repair cannot write, or a directory it cannot write into, no longer fails the switch with a server error
- Launching a conversation held by a background agent no longer rewrites it - that launch attaches to the agent and never needs the repair

## [1.0.31] - 2026-08-26

### Fixed

- `claude -c` in a project now resumes the conversation you last opened or switched to in the panel, including one that has been compacted - Claude Code refuses to continue a compacted conversation, so the terminal reported "No conversation found to continue" against a session the panel opened without complaint
- A single session record carrying an out-of-range process id no longer breaks the project list - one unusable value now costs its own row a field instead of failing the listing for every project on every refresh

## [1.0.30] - 2026-08-19

### Fixed

- Panels come back within a second of a laptop waking or a tab regaining focus - the extension re-checks which assistants are available on `online` and on the tab becoming visible, instead of leaving the sidebar empty until the next 60-second refresh
- A status check that times out can no longer discard a newer one that succeeded - overlapping checks are now ordered, so a slow request finishing late cannot undock every panel while the server is healthy
- The warning printed when a status check fails no longer promises a retry schedule it cannot honour, and no longer implies the panels are gone for good

## [1.0.29] - 2026-08-14

### Changed

- No runtime change - the defect ledger now records two reported symptoms as environment, not extension: a burst of 404s from the panel's endpoints that never reached the Jupyter server (a hop in front of it, with two unrelated extensions failing in the same instant), and a `Show in File Browser` that looked dead because the file browser was already sitting in the target folder

## [1.0.28] - 2026-08-14

### Added

- Browser-rendered proof that an armed launch mode leaves the header + with no menu at all - it clicks through and starts the session, which until now was asserted only under jsdom (Galata 29 checks)

## [1.0.27] - 2026-08-13

### Changed

- The header + menu entries read `New session` and `New session (Skip Permissions)` - the provider name gone from both - and the button's tooltip is the static `New session in current folder`, no longer interpolating a folder path that deep trees make unreadable; the armed launch mode is still named in the tooltip's parentheses

## [1.0.25] - 2026-08-13

### Changed

- The header new-session button's tooltip reads `New session in <folder>` - the provider name dropped, since the panel's own tab already says which assistant it is; the armed launch mode is still named in parentheses, and an armed mode still means the button launches on click with no menu

## [1.0.23] - 2026-08-12

### Changed

- Gemini settings collapse to a single approval control - the YOLO switch - like every other provider; the four-rung `approvalMode` dropdown is gone (`auto_edit` and `plan` are no longer settable, and a stale saved key is ignored)
- The panel's header new-session button always wears +, whatever launch mode is armed - the armed mode is still named in its tooltip, and the shield marks only the menu entries that skip approval

### Removed

- The enum launch-mode machinery (`kind`/`values`/`unsafeValues` on `ILaunchMode`, the resolver's enum-precedence branch, the schema generator's enum output) - dead once Gemini's ladder went

## [1.0.21] - 2026-08-12

### Changed

- The shield on the permission-skipping entries paints in the theme's standard grey like every other menu icon - the shape alone marks the entry, replacing the orange fill
- `Clean Up Parallel Sessions` wears its own sweep-trash glyph (the bulk variant of the trash `Remove from ...` carries) instead of sharing the unsafe-launch shield

## [1.0.19] - 2026-08-11

### Changed

- The danger marker on the unsafe launch entries (`Resume (Skip Permissions)` and its New/Branch variants, plus the destructive `Clean Up Parallel Sessions`) is now the shield - the established glyph for an action touching the permission system - replacing the caution triangle; its conspicuous 16x16 orange rendering is unchanged

## [1.0.17] - 2026-08-11

### Added

- Single home for the recent-conversations limit constants (`src/core/limits.ts`), shared by the panel, the settings plugin and the schema generator
- Migration end-to-end test against a real standalone-extension settings and favourites shape, plus tests pinning the state-write logging, the CLI timeout parity floor and the route-side switch pin
- Background-agent chip rendered proof in the Galata suite (now 27 checks)

### Changed

- Store `switch()` contract slimmed to `{"requested"}` - the route owns both the pin write (IOLoop thread) and the post-pin `current` resolution; four dead store-side resolutions deleted and every switch docstring made truthful
- State and colour file writes serialised on the IOLoop again after an executor conversion had de-serialised them (lost update reproduced 200/200)
- `namingStrategy` union collapsed to `promptsForBranchName: boolean`; saved settings parsed once per request instead of four to five times
- Per-file metadata caches capped in gemini and kimi to match claude's

### Fixed

- Every switch after the first in a pinned project answered the OLD pin as `current` and toasted a failure for a switch that succeeded (kimi and gemini since the port)
- Claude's store-internal pin write raced the loop-side writers from the executor pool
- Command rejection toasts for terminal-open and folder-open now name the failed command; request timeouts read as a slow server, not a dead one
- Swallowed `OSError`s in the state store now log provider, path and errno
- Block-comment stripping in the core-neutrality guard preserved line numbers (a measured ~141-line report skew)
- Defect ledger grown to 110 entries, 0 open, across adversarial rounds 8-20 ending in a clean two-lens pair

## [1.0.10] - 2026-08-10

### Added

- Client-side request deadline: every server call is bounded at 60 seconds, with a distinct timeout error so the panel can tell a slow server from a dead one
- Browser-measured panel regression suite (`ui-tests/tests/panel-regressions.spec.ts`, Galata 26/26)
- Cross-runtime descriptor parity guard now also binds the display label, launch-mode values and the derived tab colour (UTF-8 FNV-1a, 508-id differential corpus)

### Changed

- Colour store rewritten around a serialised operation chain - optimistic cache writes, rollbacks and write-sequencing removed; the cache holds only server-confirmed values
- Context menu, branch submenus and tab-colour capture hardened against right-click races (generation token, per-project branch cache, bounded state budget)
- Destructive and listing routes moved off the IOLoop into an executor, including the launch pre-flight (a measured 191 ms whole-server freeze per row click)

### Fixed

- Server refusals rendered as the literal `[object Object]` instead of the error message
- Cleanup of an already-clean project reported "Cleanup failed" instead of "Nothing left to clean up."
- Colour refresh polling could queue unboundedly behind a hung server
- sdists shipped internal files (`.claude/`, `logs/`, `docs/defects.md`) - now excluded from the package
- Gemini terminals were unidentifiable on Node 24 and below (`/proc` comm-name match), spawning duplicates and never tinting
- A further ~70 defects from the seven-round adversarial campaign, tracked in `docs/defects.md`

## [0.6.17] - 2026-08-08

### Changed

- Kimi panel icon replaced with the official Moonshot "K" mark (the `k-only` glyph from Moonshot's branding guide) rendered monochrome in the theme foreground
- Gemini panel icon replaced with the silhouette of Google's official 2025 Gemini spark, rendered monochrome in the theme foreground
- README rewritten to the full launcher-and-manager shape: why-section, complete feature list, migration guide from the standalone extensions, build-pin warning, and a panel screenshot

## [0.6.15] - 2026-08-07

### Added

- Initial release consolidating `jupyterlab_claude_code_extension`, `jupyterlab_codex_extension` and `jupyterlab_kimi_code_extension` into one provider-registry extension with Claude Code, Codex, Kimi and Gemini panels, a joint settings page with live per-assistant toggles, and one-shot migration of standalone settings and favourites
