"""The descriptor exists twice - once per runtime - and nothing else binds them.

``src/providers/<id>.ts`` and ``providers/<id>.py`` each declare the provider
for their own side of the wire. This test is the binding: it imports the
compiled TS descriptors under Node and asserts both registries agree on the
fields the wire protocol depends on - id set, CLI binary, fork strategy,
colour source and launch-mode tokens. A drift here ships a panel that asks its
server for behaviour the server does not recognise.

Skips when the compiled ``lib/providers`` output or ``node`` is unavailable
(sdist test environments) - the source build in CI always has both.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from jupyterlab_ai_code_assistants_extension.core import registry

REPO = Path(__file__).resolve().parents[2]
LIB_PROVIDERS = REPO / "lib" / "providers"

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
      launchModes: (d.launchModes ?? []).map(x => x.id)
    });
  }
  console.log(JSON.stringify(out));
})();
"""


def _ts_descriptors():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node not on PATH")
    if not LIB_PROVIDERS.is_dir():
        pytest.skip("lib/providers not built (run make install first)")
    proc = subprocess.run(
        [node, "-e", _NODE_DUMP, str(LIB_PROVIDERS)],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    return {d["id"]: d for d in json.loads(proc.stdout)}


def _mode_tokens(raw):
    # The Python side flattens enum modes into their accepted wire tokens
    # ("approvalMode=yolo"); the TS side keeps one id with a values list.
    # Parity is on the mode id, so strip the flattening before comparing.
    return sorted({token.split("=", 1)[0] for token in raw})


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
        assert t["cliBinary"] == d.cli_binary, pid
        assert t["forkStrategy"] == c.fork_strategy, pid
        assert t["colourSource"] == c.colour_source, pid
        assert _mode_tokens(t["launchModes"]) == _mode_tokens(c.launch_modes), pid
