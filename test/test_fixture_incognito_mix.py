"""Consumer assertions for the ``incognito-mix`` seed fixture."""

from pathlib import Path

from kiro_crew.history import ConversationLog, is_incognito_transcript
from kiro_crew.testing.fixtures import seeded_home


def _metadata(home: Path, session_key: str) -> dict[str, object]:
    return ConversationLog(base_dir=home / "sessions").get_metadata(session_key)


def _memory_mode(home: Path, session_key: str) -> object:
    return _metadata(home, session_key)["memory_mode"]


def _pinned(home: Path, session_key: str) -> object:
    """The flag that makes a default-config startup restore the session as a tab."""
    return _metadata(home, session_key)["pinned"]


def test_normal_session_is_included() -> None:
    with seeded_home("incognito-mix") as home:
        memory_mode = _memory_mode(home, "dashboard_normal")
        pinned = _pinned(home, "dashboard_normal")

    assert memory_mode == "persistent"
    assert not is_incognito_transcript(memory_mode)
    assert pinned is True


def test_incognito_session_is_private() -> None:
    with seeded_home("incognito-mix") as home:
        memory_mode = _memory_mode(home, "dashboard_incognito")
        pinned = _pinned(home, "dashboard_incognito")

    assert memory_mode == "incognito"
    assert is_incognito_transcript(memory_mode)
    assert pinned is True


def test_temporary_session_is_private() -> None:
    with seeded_home("incognito-mix") as home:
        memory_mode = _memory_mode(home, "dashboard_temporary")

    assert memory_mode == "temporary"
    assert is_incognito_transcript(memory_mode)
