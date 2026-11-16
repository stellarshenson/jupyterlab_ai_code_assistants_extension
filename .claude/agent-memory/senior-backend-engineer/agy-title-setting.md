---
name: agy-title-setting
description: agy 1.5.9 terminal title via the global settings key `title` running agy_title.py; event-driven only; hooks not settings keys; fork/tty/test-fake traps
metadata:
  type: project
---

Measured 2026-11-16 on agy 1.5.9 under `script -qfc`.

- Settings key `title` = `{"type":"command","command":"<cmd>"}` (same shape as `statusLine`); agy runs the command with JSON on stdin (`agent_state`: authenticating|idle|working, `conversation_title`, `conversation_id`, cwd, model...) and writes its stdout as OSC 2 (BEL); identical output is not re-sent; OSC 2 '' on exit
- Runs on state/UI changes, ~300 ms debounce, never on a timer (`interval` field tried: no effect) - an animation needs an own loop writing `/dev/tty` (works: the command has agy's controlling tty)
- `--settings` validates top-level keys (`hooks` → "unknown setting"); a given key replaces the saved one whole, other saved keys stay; settings.json untouched
- Hooks live only in `hooks.json` (`~/.gemini/config/` or `<ws>/.agents/`), cwd = that folder, stderr never reaches the screen, `/dev/tty` writes do
- A rename written to annotations/<id>.pbtxt while agy runs does not reach `conversation_title` until restart
- `/title [on|off]` toggles it in the TUI and saves settings.json - never type it against the real store

- Decided 2026-11-16: the key lives in the owner's global settings.json (per user, every agy), command `python -I -m jupyterlab_ai_code_assistants_extension.agy_title`; the extension's own agy tab naming (`sendsNoTerminalTitle`) was removed
- `python -m <package>.<module>` imports the package `__init__` first; it used to import core.routes (~180 ms vs ~20 ms), so `__init__` defers that import - keep it light
- The busy loop must open `/dev/tty` before `setsid`; after it there is no controlling terminal to open
- Test fakes: a shebang script named `agy` has comm `agy`, but a `$(...)` subshell of an sh script copies that comm, so the ancestor walk stops at the subshell; the fake agy is a Python script that runs `sh -c`
- Counting title loops by `/proc/*/cmdline`: match `\0-m\0<package>.agy_title`, since the fake agy's own argv carries the whole command string; `trash-put` cannot trash under `/tmp` (other volume), so scratch harnesses use a fresh dir per run

**Why:** the Antigravity tab title/busy-marker design rests on these.
**How to apply:** change the title through `agy_title.py` and the owner's settings key, never through extension-side tab naming. See [[agy-store-mechanics]].
