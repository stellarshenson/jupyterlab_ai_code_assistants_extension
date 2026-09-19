"""The Python core names no assistant.

The TypeScript half of this guard lives in ``src/__tests__/core-neutrality.spec.ts``
and scans ``src/core/`` plus the composition root. The server half had none, so
``if provider_id == "claude"`` inside ``core/routes.py`` would have shipped with
every behaviour test green - the architecture promise ("adding or removing an
assistant touches one provider module and one barrel line") is not expressible
as a behaviour, so the source itself is the assertion.

Comments and docstrings are stripped before the scan: the core is allowed to
EXPLAIN why an assistant needed a capability flag, it is just not allowed to
branch on one.
"""
from __future__ import annotations

import ast
import io
import re
import tokenize
from pathlib import Path

import pytest

from jupyterlab_ai_code_assistants_extension.core import registry


#: Names the roster carries that no descriptor field spells out - the vendors
#: behind the assistants. A core file branching on ``anthropic`` is the same
#: violation as one branching on ``claude``, and neither word can be derived
#: from a descriptor, so this is the one list still maintained by hand.
VENDOR_ALIASES = ("anthropic", "moonshot")

#: Label words that name the CATEGORY rather than the assistant. ``Claude
#: Code`` contributes ``claude``; ``code`` on its own appears in half the core
#: (``encoded_path``, ``exit_code``) and as a name would flag all of them.
GENERIC_LABEL_WORDS = frozenset({"ai", "assistant", "assistants", "cli", "code", "sessions"})

CORE_DIR = Path(registry.__file__).parent


def assistant_names(descriptors) -> list[str]:
    """Every word that names an assistant, read off the registry.

    Derived rather than typed out for the same reason the frontend scan derives
    it: a sixth provider joins the package, nobody remembers this file, and a
    frozen ``claude|codex|kimi`` alternation walks straight past a core file
    branching on the new id.
    """
    names = set(VENDOR_ALIASES)
    for descriptor in descriptors:
        names.add(descriptor.id)
        names.add(descriptor.cli_binary)
        if descriptor.legacy is not None:
            names.add(descriptor.legacy.plugin_id)
        for word in descriptor.label.split():
            lower = word.lower()
            if lower and lower not in GENERIC_LABEL_WORDS:
                names.add(lower)
    return sorted(name for name in names if name)


def name_pattern(names: list[str]) -> re.Pattern[str]:
    """One alternation over the roster, matched case-insensitively."""
    return re.compile("|".join(re.escape(name) for name in names), re.IGNORECASE)


def strip_comments_and_docstrings(source: str) -> str:
    """Blank every comment and docstring, keeping the line count intact.

    Line numbers have to survive, or a violation is reported at the wrong line
    and nobody finds it; every removal is replaced with spaces on its own line
    rather than deleted.
    """
    lines = source.splitlines()

    def blank(row: int, start: int, end: int) -> None:
        line = lines[row]
        lines[row] = line[:start] + " " * max(0, end - start) + line[end:]

    try:
        tree = ast.parse(source)
    except SyntaxError:  # pragma: no cover - a core file that will not parse
        pytest.fail("a core file does not parse")
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
            for row in range(first.lineno - 1, (first.end_lineno or first.lineno)):
                lines[row] = " " * len(lines[row])

    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT:
            blank(token.start[0] - 1, token.start[1], token.end[1])

    return "\n".join(lines)


def names_an_assistant(line: str, pattern: re.Pattern[str]) -> bool:
    """Whether ``line`` carries a name as a word of its own.

    A bare token, a quoted string or a snake_case segment counts; a name that
    merely occurs inside a longer word does not - ``dsh`` is DeepSeek's binary
    and it sits inside ``windshield``.
    """
    for match in pattern.finditer(line):
        before = line[match.start() - 1] if match.start() else ""
        after = line[match.end()] if match.end() < len(line) else ""
        starts_word = not before.isalnum()
        ends_word = not (after.isalnum() and after.islower() or after.isdigit())
        if starts_word and ends_word:
            return True
    return False


def offenders(source: str, pattern: re.Pattern[str]) -> list[tuple[int, str]]:
    """Lines of ``source`` that name an assistant, as ``(line number, text)``."""
    return [
        (number, line)
        for number, line in enumerate(strip_comments_and_docstrings(source).split("\n"), start=1)
        if names_an_assistant(line, pattern)
    ]


def core_files() -> list[Path]:
    return sorted(path for path in CORE_DIR.glob("*.py") if path.name != "__init__.py")


PATTERN = name_pattern(assistant_names([p.descriptor for p in registry.providers().values()]))


# ------------------------------------------------------------------ the scan


def test_the_python_core_names_no_assistant():
    """The guard itself: no core module branches on, or mentions, an assistant."""
    found = {
        path.name: offenders(path.read_text(encoding="utf-8"), PATTERN)
        for path in core_files()
    }
    violations = {name: lines for name, lines in found.items() if lines}
    assert violations == {}, "\n".join(
        f"{name}:{number}: {text.strip()}"
        for name, lines in violations.items()
        for number, text in lines
    )


def test_the_scan_has_core_files_to_read():
    """Guards against the scan passing because it found nothing to read."""
    assert len(core_files()) >= 4


# ----------------------------------------------------- the name list it runs on


def test_the_name_list_is_the_registry_read_at_run_time():
    names = assistant_names([p.descriptor for p in registry.providers().values()])
    for provider in registry.providers().values():
        assert provider.descriptor.id in names
        assert provider.descriptor.cli_binary in names


def test_the_name_list_grows_with_the_roster():
    """A sixth provider is covered without this file being edited."""

    class _Descriptor:
        id = "nimbus"
        label = "Nimbus Code"
        cli_binary = "nmb"
        legacy = None

    names = assistant_names([_Descriptor()])
    assert "nimbus" in names
    assert "nmb" in names


def test_the_name_list_drops_the_words_that_name_the_category():
    class _Descriptor:
        id = "nimbus"
        label = "Nimbus Code Assistant CLI"
        cli_binary = "nmb"
        legacy = None

    assert set(assistant_names([_Descriptor()])) == {"anthropic", "moonshot", "nimbus", "nmb"}


def test_the_name_list_keeps_the_retired_extension_names():
    names = assistant_names([p.descriptor for p in registry.providers().values()])
    assert "jupyterlab_claude_code_extension" in names


# ------------------------------------------------------- what the scan flags


def test_a_branch_on_a_provider_id_is_flagged():
    source = 'def pick(provider_id):\n    if provider_id == "claude":\n        return 1\n'
    assert offenders(source, PATTERN) == [(2, '    if provider_id == "claude":')]


def test_a_snake_case_segment_naming_an_assistant_is_flagged():
    source = "def claude_path():\n    return 1\n"
    assert [number for number, _ in offenders(source, PATTERN)] == [1]


def test_a_name_inside_a_longer_word_is_not_flagged():
    """``dsh`` is DeepSeek's binary and it sits inside ordinary words."""
    source = "windshield = 1\n"
    assert offenders(source, PATTERN) == []


def test_a_comment_naming_an_assistant_is_allowed():
    source = "# claude appends a custom-title record\nvalue = 1\n"
    assert offenders(source, PATTERN) == []


def test_a_docstring_naming_an_assistant_is_allowed():
    source = '"""Why kimi needs its own flag."""\n\nvalue = 1\n'
    assert offenders(source, PATTERN) == []


def test_code_beside_a_trailing_comment_is_still_scanned():
    source = 'name = "kimi"  # the id, not a branch\n'
    assert [number for number, _ in offenders(source, PATTERN)] == [1]


def test_a_violation_past_a_docstring_keeps_its_real_line_number():
    source = '"""One\ntwo\nthree\n"""\nvalue = 1\nif x == "gemini":\n    pass\n'
    assert [number for number, _ in offenders(source, PATTERN)] == [6]
