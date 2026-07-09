"""Covers mcp_wrapper.skill_queue: queue/draft/decide lifecycle."""
import os
from pathlib import Path

from mcp_wrapper import skill_queue


def test_queue_skill_returns_uuid():
    queue_id = skill_queue.queue_skill("my-skill", "# My Skill\ncontent")
    assert isinstance(queue_id, str) and len(queue_id) > 0


def test_get_draft_roundtrips_fields():
    queue_id = skill_queue.queue_skill("draft-skill", "# Draft\nbody text")
    draft = skill_queue.get_draft(queue_id)
    assert draft["ok"] is True
    assert draft["proposed_name"] == "draft-skill"
    assert draft["skill_markdown"] == "# Draft\nbody text"
    assert draft["status"] == "pending"


def test_get_draft_unknown_queue_id():
    draft = skill_queue.get_draft("nope")
    assert draft == {"ok": False, "error": "unknown queue_id"}


def test_decide_approve_writes_skill_md_as_is():
    queue_id = skill_queue.queue_skill("approve-skill", "# Approve\nmarkdown body")
    result = skill_queue.decide(queue_id, "APPROVE")
    assert result == {"ok": True, "status": "approved"}
    skill_path = skill_queue.SKILLS_DIR / "approve-skill" / "SKILL.md"
    assert skill_path.read_text() == "# Approve\nmarkdown body"


def test_decide_approve_with_edited_markdown():
    queue_id = skill_queue.queue_skill("edited-skill", "# Original\nbody")
    result = skill_queue.decide(queue_id, "APPROVE", edited_markdown="X")
    assert result == {"ok": True, "status": "approved_edited"}
    skill_path = skill_queue.SKILLS_DIR / "edited-skill" / "SKILL.md"
    assert skill_path.read_text() == "X"


def test_decide_reject_does_not_create_skill_dir():
    queue_id = skill_queue.queue_skill("reject-skill", "# Reject\nbody")
    result = skill_queue.decide(queue_id, "REJECT")
    assert result == {"ok": True, "status": "rejected"}
    skill_dir = skill_queue.SKILLS_DIR / "reject-skill"
    assert not skill_dir.exists()


def test_second_decide_on_same_id_rejected_with_current_status():
    queue_id = skill_queue.queue_skill("double-decide", "# Body")
    first = skill_queue.decide(queue_id, "APPROVE")
    assert first["status"] == "approved"
    second = skill_queue.decide(queue_id, "APPROVE")
    assert second == {"ok": False, "error": "already approved"}


def test_decide_unknown_queue_id():
    result = skill_queue.decide("no-such-id", "APPROVE")
    assert result == {"ok": False, "error": "unknown queue_id"}


def test_decide_nested_path_segment_resolves_under_skills_dir_documented_behavior():
    """G1R OQ4 — DOCUMENTED, NOT FIXED in 0E.

    `proposed_name` is used directly as a path segment in `decide()`
    (`SKILLS_DIR / name`). A name containing a path separator (e.g.
    "../escape" or "nested/sub") will resolve relative to SKILLS_DIR rather
    than being confined to a flat child directory. This test PINS the current
    behavior so a future change is intentional, not accidental; path-escape
    sanitization is a documented follow-up and is explicitly OUT OF SCOPE for
    this ticket (0E). Do NOT add sanitization here.
    """
    nested_name = "nested/sub-skill"
    queue_id = skill_queue.queue_skill(nested_name, "# Nested\nbody")
    result = skill_queue.decide(queue_id, "APPROVE")
    assert result == {"ok": True, "status": "approved"}

    expected_path = skill_queue.SKILLS_DIR / nested_name / "SKILL.md"
    assert expected_path.exists()
    assert expected_path.read_text() == "# Nested\nbody"
