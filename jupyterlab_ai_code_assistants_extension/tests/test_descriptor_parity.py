"""The descriptor exists twice - once per runtime - and nothing else binds them.

``src/providers/<id>.ts`` and ``providers/<id>.py`` each declare the provider
for their own side of the wire. This test is the binding: it imports the
compiled TS descriptors under Node and asserts both registries agree on the
fields the wire protocol depends on - id set, CLI binary, fork strategy,
colour source and launch-mode tokens, enum VALUES included. A drift here ships
a panel that asks its server for behaviour the server does not recognise.

The derived tab colour is bound the same way, and for the same reason: the
FNV-1a hash and the six-colour vocabulary are written out twice, so a
conversation would tint differently depending on which runtime resolved it.

Skips when the compiled ``lib/`` output or ``node`` is unavailable (sdist test
environments) - the source build in CI always has both. It does NOT skip when
``lib/`` is merely STALE: see :func:`_require_fresh_lib`.
"""

import json
import random
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

from jupyterlab_ai_code_assistants_extension.core import registry
from jupyterlab_ai_code_assistants_extension.providers import kimi

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
LIB = REPO / "lib"
LIB_PROVIDERS = LIB / "providers"
LIB_COLOUR = LIB / "core" / "colour.js"
#: tsc's incremental record. Counted alongside ``lib/`` as a build marker
#: because a compile can legitimately refresh it while emitting no ``.js`` at
#: all. It is NOT a general answer - measured, a compile whose sources are
#: semantically unchanged writes neither this file nor any output - see
#: ``_require_fresh_lib``.
BUILD_INFO = REPO / "tsconfig.tsbuildinfo"

# What refreshes ``lib/``. Named in the failure message below because the test
# suite itself never runs it - ``make test`` is pytest and jest, nothing more.
BUILD_COMMAND = "make install"

_NODE_DUMP = """
const { readdirSync } = require('fs');
(async () => {
  const out = [];
  for (const f of readdirSync(process.argv[1])
    .filter(x => x.endsWith('.js') && x !== 'index.js')
    .sort()) {
    const m = await import(process.argv[1] + '/' + f);
    if (!m.descriptor) { continue; }
    const d = m.descriptor;
    out.push({
      id: d.id,
      cliBinary: d.cliBinary,
      forkStrategy: d.forkStrategy,
      colourSource: d.colourSource,
      // Flattened into the tokens the Python side stores, VALUES and all: an
      // enum mode reaches a store as one string, so `approvalMode=yolo` is
      // the unit both runtimes have to agree on. Comparing mode ids alone
      // discards exactly the drift this file exists to catch.
      launchModes: (d.launchModes ?? []).flatMap(x =>
        x.kind === 'enum'
          ? (x.values ?? []).map(v => x.id + '=' + v)
          : [x.id]
      ),
      legacyPluginId: d.legacyPluginId ?? null,
      label: d.label
    });
  }
  console.log(JSON.stringify(out));
})();
"""

# `lib/core/colour.js` is an ES module that imports the request helper, which
# Node cannot resolve on its own - tsc emits extensionless specifiers, which
# are a bundler's job rather than Node's. Evaluating it as a vm module with a
# stub linker runs the SHIPPED artifact without needing a bundler: the hash and
# the colour vocabulary are pure, and the stubbed import is never called.
_COLOUR_DUMP = """
const vm = require('vm');
const { readFileSync } = require('fs');
(async () => {
  // TextEncoder is a platform global everywhere the real module runs - every
  // browser, jsdom and Node - but a vm context starts with none of them, so
  // the sandbox has to hand back the ones the module legitimately uses. It is
  // deliberately the ONLY one: anything else the module reaches for should
  // fail here loudly rather than be quietly supplied.
  const ctx = vm.createContext({ TextEncoder });
  const mod = new vm.SourceTextModule(readFileSync(process.argv[1], 'utf8'), {
    identifier: 'colour.js',
    context: ctx
  });
  await mod.link(
    spec =>
      new vm.SyntheticModule(
        ['requestProvider'],
        function () {
          this.setExport('requestProvider', () => {
            throw new Error('the pure colour helpers must not reach the wire');
          });
        },
        { context: ctx, identifier: spec }
      )
  );
  await mod.evaluate();
  const ids = JSON.parse(process.argv[2]);
  console.log(
    JSON.stringify({
      vocabulary: mod.namespace.TAB_COLOUR_IDS,
      colours: ids.map(id => mod.namespace.fnv1aColour(id))
    })
  );
})();
"""


def _newest(root: Path, suffix: str, skip: frozenset = frozenset()):
    """``(mtime, path)`` of the most recently written file under ``root``."""
    newest = 0.0
    newest_path: Path | None = None
    for path in root.rglob("*" + suffix):
        if skip.intersection(path.parts):
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if mtime > newest:
            newest, newest_path = mtime, path
    return newest, newest_path


def _require_fresh_lib() -> None:
    """Fail when ``lib/`` predates ``src/``.

    Every assertion in this file reads a BUILT artifact, and nothing in the
    test path builds it - ``make test`` runs pytest and jest, so a parity
    guard left to itself happily certifies today's Python against yesterday's
    TypeScript and reports green. That is a guard that cannot fail for the one
    reason it exists, which is worse than no guard at all.

    A hard failure rather than a skip: a skip is what a stale build already
    looks like from the outside, and it would restore the silence.

    ``src/__tests__`` is excluded because tsc never compiles it (see the
    ``exclude`` in ``tsconfig.json``), so editing a spec would otherwise leave
    this permanently red.

    ONE FALSE POSITIVE IS KNOWN AND UNAVOIDABLE HERE, so the message names its
    remedy. ``tsconfig.json`` sets ``incremental: true``: a compile whose
    sources are semantically unchanged emits nothing AND does not refresh
    ``tsconfig.tsbuildinfo``, so touching a file without changing its content -
    exactly what restoring from a scratch copy after a mutation check does -
    leaves this red with no ordinary rebuild able to clear it (DEF-75).
    Deleting the buildinfo forces a full emit and clears it. mtime cannot
    distinguish "edited and not rebuilt" from "touched and identical", and the
    conservative direction is the right one: the failure this guard exists to
    prevent is a SILENT green, and a red that needs one documented command is
    a far cheaper mistake than certifying today's Python against yesterday's
    TypeScript.
    """
    src_mtime, src_path = _newest(SRC, ".ts", frozenset({"__tests__"}))
    lib_mtime, lib_path = _newest(LIB, ".js")
    if BUILD_INFO.is_file():
        built = BUILD_INFO.stat().st_mtime
        if built > lib_mtime:
            lib_mtime, lib_path = built, BUILD_INFO
    if src_path is None or lib_path is None or src_mtime <= lib_mtime:
        return
    pytest.fail(
        f"lib/ is older than src/: {src_path.relative_to(REPO)} was written after "
        f"{lib_path.relative_to(REPO)}. Every assertion in this file compares the "
        f"Python registry against the COMPILED TypeScript, so a stale lib/ turns "
        f"this guard into a green light for drift it never looked at. "
        f"Run `{BUILD_COMMAND}` and re-run the suite. If the rebuild does not "
        f"clear this, the file was touched without changing content: tsc's "
        f"incremental mode then emits nothing, so delete "
        f"`{BUILD_INFO.name}` to force a full emit."
    )


def _node(script: str, *args: str, vm_modules: bool = False) -> str:
    """Run one inline Node script over the built output and answer its stdout."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("node not on PATH")
    if not LIB_PROVIDERS.is_dir() or not LIB_COLOUR.is_file():
        pytest.skip(f"lib/ not built (run `{BUILD_COMMAND}` first)")
    _require_fresh_lib()
    argv = [node]
    if vm_modules:
        argv.append("--experimental-vm-modules")
    proc = subprocess.run(
        [*argv, "-e", script, *args],
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return proc.stdout


def _ts_descriptors():
    return {
        d["id"]: d for d in json.loads(_node(_NODE_DUMP, str(LIB_PROVIDERS)))
    }


def _ts_colours(session_ids: list[str]) -> dict:
    return json.loads(
        _node(
            _COLOUR_DUMP,
            str(LIB_COLOUR),
            json.dumps(session_ids),
            vm_modules=True,
        )
    )


def _colour_corpus() -> list[str]:
    """Ids to hash on both sides.

    Five hundred conversation ids in the shapes the panel actually carries -
    a bare uuid4 (claude, gemini) and kimi's ``session_<uuid>`` - plus the
    handful of inputs that separate the two implementations rather than
    exercise them. ``𝕏id`` is in there deliberately: it is the one input a
    differential run of this corpus has ever disagreed on, because JavaScript
    hashes UTF-16 code UNITS (`charCodeAt`) while Python hashes code POINTS
    (`ord`), and they part company above the basic multilingual plane.

    Seeded, so a failure names the same ids on a re-run.
    """
    rng = random.Random(20260809)
    ids = []
    for _ in range(250):
        raw = str(uuid.UUID(int=rng.getrandbits(128), version=4))
        ids.append(raw)
        ids.append(f"session_{raw}")
    ids += [
        "",
        "a",
        "0",
        "-",
        "session_",
        # Non-ASCII, ascending by how far outside ASCII it sits.
        "café",
        "日本語",
        "𝕏id",
    ]
    return ids


def test_both_registries_declare_the_same_providers():
    ts = _ts_descriptors()
    py = registry.providers()
    assert sorted(ts) == sorted(py)


def test_descriptor_fields_agree_across_runtimes():
    ts = _ts_descriptors()
    for pid, provider in sorted(registry.providers().items()):
        d = provider.descriptor
        c = d.capabilities
        t = ts[pid]
        # The display name exists in BOTH runtimes and is READ in both - the
        # schema generator and the panel use the TypeScript one, `routes.py`
        # sends the Python one on every listing, and `ui-tests` asserts the
        # rendered tab against it. Two copies of one user-visible string with
        # nothing binding them is the same shape as `legacyPluginId` below.
        assert t["label"] == d.label, pid
        assert t["cliBinary"] == d.cli_binary, pid
        assert t["forkStrategy"] == c.fork_strategy, pid
        assert t["colourSource"] == c.colour_source, pid
        # Whole tokens, `mode=value` included. A mode whose VALUES drift - one
        # runtime offering `approval_mode=plan` the other never accepts - is a
        # menu entry that reaches the store and is silently dropped on the way
        # to the CLI, which is the failure this used to compare its way past.
        assert sorted(t["launchModes"]) == sorted(c.launch_modes), pid
        # The retired plugin id carries two different jobs off one string -
        # TypeScript suppresses this panel when that plugin is still installed,
        # Python reads the same name as the user-settings folder to migrate
        # from. Drift gives working suppression against an empty folder, or
        # the reverse, and both are silent.
        assert t["legacyPluginId"] == (
            d.legacy.plugin_id if d.legacy is not None else None
        ), pid


def test_the_colour_vocabulary_is_the_same_list_in_both_runtimes():
    """Same six ids, same ORDER.

    The order is what the hash indexes into, so a reordered copy tints every
    conversation differently while both lists still hold the same six names.
    """
    assert _ts_colours([])["vocabulary"] == list(kimi._TAB_COLOUR_IDS)


def test_the_derived_colour_agrees_across_runtimes():
    """One tint per conversation, whichever runtime resolved it.

    The frontend derives a colour when it has a session id in hand and the
    server derives one while building a row, so the two implementations answer
    the same question about the same id at different moments. Nothing but this
    test binds them.
    """
    corpus = _colour_corpus()
    ts = _ts_colours(corpus)["colours"]
    divergent = [
        (session_id, theirs, kimi.derived_colour(session_id))
        for session_id, theirs in zip(corpus, ts)
        if theirs != kimi.derived_colour(session_id)
    ]
    assert divergent == [], (
        f"{len(divergent)} of {len(corpus)} ids hash to different colours: "
        f"{divergent[:5]} (id, TypeScript, Python)"
    )
