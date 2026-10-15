"""Shipped copies of two crewmate rules agree with the Crew Members page.

``src/kiro_crew/docs/crew-members.md`` states two rules a reader acts on, and
other shipped strings repeat them where the page is not read:

- **Routing.** Delegating to a crewmate is ``spawn_run(crew=...)``. ``agent=``
  names a template and runs on the caller's memory, so a prompt or skill that
  routes with ``select_crew`` / ``route_crew`` and then says ``spawn_run(agent=``
  sends the crewmate's work into the wrong store.
- **Short-name collisions.** Renaming changes only the name a crewmate shows,
  never its short name, so the Members page's collision notices must not offer
  a rename as the fix.

Each test reads the shipped copy itself, so a copy that drifts back fails here
even though the page stays right.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
PACKAGE = ROOT / "src" / "kiro_crew"
DOC = PACKAGE / "docs" / "crew-members.md"
EN = ROOT / "website" / "src" / "i18n" / "locales" / "en.json"

_ROUTING_TOOL = re.compile(r"\b(select_crew|route_crew)\b")


def test_no_shipped_markdown_routes_to_a_crewmate_with_agent() -> None:
    """A packaged prompt, skill or doc that names a routing tool never says `spawn_run(agent=`."""
    pages = sorted(PACKAGE.rglob("*.md"))
    assert (
        PACKAGE / "builtin_skills" / "goal-conductor" / "SKILL.md" in pages
    ), "the scan no longer reaches the packaged skills"
    offenders = [
        str(p.relative_to(ROOT))
        for p in pages
        if _ROUTING_TOOL.search(text := p.read_text("utf-8")) and "spawn_run(agent=" in text
    ]
    assert not offenders, f"these copies route to a crewmate with agent=, not crew=: {offenders}"


def _members_page_copy() -> dict[str, str]:
    catalog = json.loads(EN.read_text(encoding="utf-8"))
    return catalog["pages"]["membersPage"]


def test_collision_notices_offer_the_remedy_the_page_states() -> None:
    """Both short-name collision notices say delete-and-recreate, as the page does."""
    doc = DOC.read_text(encoding="utf-8")
    assert (
        "never its short name" in doc and "delete the crewmate that shows this notice" in doc
    ), "the page no longer states the collision remedy these notices are pinned to"
    copy = _members_page_copy()
    # Which crewmate to delete matters: the thread stays bound to its owner (the
    # one `slug_collision` names), so deleting the owner leaves the survivor
    # refused with `member_pin_mismatch`. "Delete one" is the wrong remedy too.
    remedies = {
        "slug_collision": "delete this crewmate, not {{name}},",
        "notes_collision": "delete the one whose chat shows a short-name notice",
    }
    for key, remedy in remedies.items():
        text = copy[key]
        assert "Renaming keeps the short name" in text, f"{key} no longer says a rename cannot help"
        assert remedy in text and "create it again" in text, f"{key} lost the remedy"
        assert not re.search(r"\b(Rename|delete) one\b", text), f"{key} offers a fix that fails"
