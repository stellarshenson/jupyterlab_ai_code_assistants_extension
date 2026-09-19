"""The Galata harness's own invariants, read off the files that carry them.

These are properties of the TEST rig, not of the extension, and every one of
them has already cost a run: a suite that adopted a developer's live JupyterLab,
a sweep that deleted a concurrent run's fixtures, a pipe through ``tee`` that
turned a server that never started into a pass. None of them is expressible as
a Galata assertion - a rig that is wrong does not fail, it passes against the
wrong thing - so the configuration is the assertion.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest


REPO = Path(__file__).resolve().parents[2]
UI = REPO / "ui-tests"
PLAYWRIGHT_CONFIG = UI / "playwright.config.js"
SERVER_CONFIG = UI / "jupyter_server_test_config.py"
TEARDOWN = UI / "global-teardown.js"
README = UI / "README.md"
INDEX_TS = REPO / "src" / "index.ts"
TEMPLATE_SPEC = UI / "tests" / "jupyterlab_ai_code_assistants_extension.spec.ts"

#: Environment variables that hand a spawned server someone else's credentials.
INHERITED_TOKENS = ("JUPYTERHUB_API_TOKEN", "JPY_API_TOKEN", "JUPYTER_TOKEN")


def read(path: Path) -> str:
    if not path.is_file():
        pytest.skip(f"{path.relative_to(REPO)} not present (sdist test run)")
    return path.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def playwright_config() -> str:
    return read(PLAYWRIGHT_CONFIG)


@pytest.fixture(scope="module")
def server_config() -> str:
    return read(SERVER_CONFIG)


# --------------------------------------------------------------- the port knob


def test_the_port_knob_reaches_the_base_url_the_command_and_the_server_config(
    playwright_config, server_config
):
    """One value, three places, or the browser and the server disagree."""
    assert "process.env.JLAB_TEST_PORT" in playwright_config
    assert "baseURL: `http://localhost:${port}`" in playwright_config
    assert "--port ${port}" in playwright_config
    assert 'os.environ.get("JLAB_TEST_PORT")' in server_config


def test_an_exported_but_empty_port_falls_back_rather_than_raising(server_config):
    """``get(name, default)`` answers the EMPTY STRING for an exported-but-empty
    variable, and an empty port is not a port. ``get(name) or default`` is the
    only form that survives it."""
    assert 'os.environ.get("JLAB_TEST_PORT") or "8888"' in server_config
    assert 'os.environ.get("JLAB_TEST_PORT", "8888")' not in server_config
    # The semantics the line depends on, stated as an executable fact.
    assert (os.environ.get("_absent_on_purpose_") or "8888") == "8888"
    assert ({"X": ""}.get("X") or "8888") == "8888"
    assert {"X": ""}.get("X", "8888") == ""


# ------------------------------------------------------------- server identity


def test_a_running_lab_is_never_adopted(playwright_config):
    """The suite drives terminals and session stores; a developer's live server
    has neither the stub binaries nor the scratch stores, it has their real
    assistant history."""
    assert "reuseExistingServer: false" in playwright_config
    # Unconditionally - the one occurrence IS the literal false, so it cannot
    # sit behind an environment variable that a CI run, or a developer's shell,
    # could flip.
    assert playwright_config.count("reuseExistingServer") == 1


def test_the_specs_run_one_at_a_time(playwright_config):
    """All specs share one server and its per-provider stores, so a second
    worker would toggle settings underneath a spec asserting on them."""
    assert re.search(r"\bworkers:\s*1\b", playwright_config)
    assert re.search(r"\bfullyParallel:\s*false\b", playwright_config)


# ------------------------------------------------------------------- isolation


def test_the_runtime_and_config_dirs_are_private_to_the_run(server_config):
    for var in (
        "JUPYTER_CONFIG_DIR",
        "JUPYTER_DATA_DIR",
        "JUPYTER_RUNTIME_DIR",
    ):
        assert f'os.environ["{var}"]' in server_config


def test_inherited_hub_tokens_are_dropped_from_the_spawn_environment(server_config):
    """A token inherited from the developer's hub would let the test server
    authenticate as them."""
    for var in INHERITED_TOKENS:
        assert var in server_config
    assert "os.environ.pop(" in server_config


def test_every_assistant_store_is_redirected_out_of_the_developer_history(
    server_config,
):
    """No test reads or writes the real assistant history.

    Four assistants take an explicit root variable; Gemini derives its own from
    ``Path.home()``, which the fake HOME already covers - and that HOME is set
    in the spawn environment rather than here, because every Jupyter search path
    is resolved before this file runs.
    """
    for var in (
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "KIMI_CODE_HOME",
        "DSH_HOME",
        "JUPYTERLAB_AI_CODE_ASSISTANTS_STATE_DIR",
    ):
        # The ASSIGNMENT, and its right-hand side. Matching the name alone
        # passes on the fixture code that reads the variable back, so deleting
        # the redirect and leaving the read would have gone unnoticed.
        assert re.search(
            rf'os\.environ\["{var}"\]\s*=\s*str\(\s*(_home|SCRATCH)\b',
            server_config,
        ), f"{var} is not redirected into the scratch tree"
    assert re.search(r'os\.environ\["HOME"\]\s*=\s*str\(_home\)', server_config)


def test_the_server_runs_from_the_dedicated_venv(playwright_config):
    """A venv holding only JupyterLab and this extension is what makes "one
    panel per provider" honest: the three retired standalone extensions are
    absent from it, so a duplicate panel can only come from this package."""
    assert 'PATH="$PWD/.venv/bin:$PATH"' in playwright_config


# ----------------------------------------------------------------- the scratch


def test_the_scratch_tree_is_swept_before_the_run_and_after_it(playwright_config):
    """``globalSetup`` runs AFTER the web server, so the pre-start sweep has to
    live in the server command; the teardown does the other end."""
    assert "rm -rf .scratch/${port}" in playwright_config
    assert "globalTeardown" in playwright_config
    teardown = read(TEARDOWN)
    assert "rmSync" in teardown


def test_the_scratch_tree_is_keyed_by_the_run_own_port(playwright_config):
    """Two suites on one machine already hold different ports to both start, so
    a port-keyed path cannot alias - and a bare `.scratch` once had one run's
    pre-start sweep delete a live run's fixtures (docs/defects.md DEF-49)."""
    assert "path.join(__dirname, '.scratch', port)" in playwright_config
    for owned in ("test-results", "playwright-report"):
        assert f"path.join(__dirname, '{owned}', port)" in playwright_config


# ---------------------------------------------------------- what the rig needs


def test_the_activation_message_is_the_one_the_template_spec_waits_for():
    """The template UI test matches this string verbatim, so a reword that
    reaches only one of the two files turns the suite's first test into a
    thirty-second timeout with no explanation."""
    message = "JupyterLab extension jupyterlab_ai_code_assistants_extension is activated!"
    assert message in read(INDEX_TS)
    assert message in read(TEMPLATE_SPEC)


def test_the_run_instructions_redirect_rather_than_pipe(server_config):
    """A pipe reports the exit status of ``tee``, so a suite whose server never
    started reads as a pass."""
    readme = read(README)
    assert "Redirect the output rather than piping through `tee`" in readme


def test_no_galata_spec_answers_a_route_without_asking_the_server():
    """The tier exists to catch packaging and integration breaks; a spec that
    invents the answer proves only that its own stub answers.

    Three route uses, and only one of them crosses that line:

    * ``route.continue`` delays or observes a request the server still answers.
      That is how the in-flight cleanup dialog and the wedged wake probe are
      reproduced at all, and both are exactly the states their defects lived in
    * ``route.fulfill`` fed from ``route.fetch()`` edits the REAL answer - one
      availability flag, to take a binary off PATH mid-run, which nothing else
      can do to a server that is already up
    * ``route.fulfill`` with an invented body is the both-ends mock

    The checkable form of that distinction: a spec that writes a response must
    also call ``route.fetch()``. It is per file rather than per call, which is
    the honest limit of reading source - it cannot tell which fulfil got which
    body - but it does catch the spec that never asks the server anything.
    """
    offenders = []
    for path in sorted((UI / "tests").glob("*.spec.ts")):
        text = path.read_text(encoding="utf-8")
        if re.search(r"\broute\.fulfill\s*\(", text) and not re.search(
            r"\broute\.fetch\s*\(", text
        ):
            offenders.append(path.name)
    assert offenders == []


def test_the_galata_specs_do_drive_routes_so_the_rule_above_is_not_vacuous():
    """A rule over an empty set is not a rule. Some spec must reach for
    ``page.route`` at all, or this file is asserting nothing."""
    users = [
        path.name
        for path in sorted((UI / "tests").glob("*.spec.ts"))
        if "page.route(" in path.read_text(encoding="utf-8")
    ]
    assert users, "no spec drives a route - check the glob, not the rule"


def test_any_spawned_console_script_wires_an_error_listener():
    """A spawn with no ``error`` listener raises on the process object, which
    kills the worker instead of reporting the binary as missing from PATH."""
    roots = [REPO / "src", UI, REPO / "scripts"]
    skip = {"node_modules", "lib", ".venv", ".scratch", "test-results"}
    unguarded: list[str] = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if path.suffix not in {".js", ".ts", ".mjs", ".cjs"}:
                continue
            if skip & set(path.parts):
                continue
            text = path.read_text(encoding="utf-8")
            if re.search(r"\bspawn\s*\(", text) and "on('error'" not in text:
                unguarded.append(str(path.relative_to(REPO)))
    assert unguarded == []


def test_snapshot_baselines_update_through_the_pull_request_comment():
    """Never by a hand-committed image: the baselines are rendered by CI's own
    browser, and one rendered locally differs by fonts alone."""
    workflow = read(REPO / ".github" / "workflows" / "update-integration-tests.yml")
    assert "please update snapshots" in workflow
    assert "issue_comment" in workflow
