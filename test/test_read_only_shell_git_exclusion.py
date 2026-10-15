"""Read-only shell auto-approve never runs ``git``.

git reads ``.git/config`` on every invocation, and ``core.fsmonitor`` /
``core.hooksPath`` name a program there that no text classifier sees. So a
read-only ``git status`` still runs whatever that config names. The heartbeat
approver already keeps git out of its unattended auto-approve; the gate's
read-only tier (cron, subagent and app sessions, where nobody may be watching)
and the dashboard's trust-reads mode keep it out the same way.

What is pinned here:

* ``readonly_bash.command_invokes_git`` -- one pure rule for both sites: true
  when any command position runs git (any case, any path, ``.exe``, after a
  ``VAR=`` prefix or a program runner such as ``env``) or the quoting cannot be
  resolved;
* the gate's read-only tier: a git command gets no read-only verdict and falls
  through to the surface's own approval, while other reads still auto-approve;
* the classifier itself is unchanged: ``is_read_only_bash`` still reads a git
  read as read-only, so only the auto-approve sites change.

The trust-reads path is driven end to end in ``test_chat_runner_coverage.py``.
"""

from __future__ import annotations

import pytest

from kiro_crew.hooks import TOOL_ALLOW, TOOL_AUTO_APPROVE, HookManager, ToolCall
from kiro_crew.security.readonly_bash import command_invokes_git, is_read_only_bash

GIT_COMMANDS = [
    "git status",
    "git log --oneline -5",
    "pwd; git status",
    "ls && git diff",
    "ls | GIT log",
    "FOO=1 git status",
    "(git status)",
    "/usr/bin/git status",
    "ls\ngit status",
    "Git branch -a",
    "ls || git status",
    "{ git status; }",
    "env -i git status",
    "timeout 5 git log",
    "ls | xargs git show",
    "C:\\Git\\cmd\\git.exe status",
]

#: Reads that must keep auto-approving after the change.
STILL_APPROVED = [
    "ls -la",
    "cat README.md",
    "head -20 file.py",
    "grep -rn pattern src/",
    "wc -l file.txt",
    "ls | grep digit",
]


@pytest.mark.parametrize("command", GIT_COMMANDS)
def test_every_git_position_is_seen(command: str) -> None:
    assert command_invokes_git(command) is True


@pytest.mark.parametrize(
    "command", STILL_APPROVED + ["echo git", "grep -rn git src/", "cat .gitignore", "ls git/"]
)
def test_git_as_an_argument_is_not_a_git_run(command: str) -> None:
    assert command_invokes_git(command) is False


def test_quoting_that_cannot_be_resolved_counts_as_git() -> None:
    assert command_invokes_git("ls 'unclosed") is True


def _judge(command: str) -> object:
    return HookManager().judge(
        ToolCall(title=f"Running: {command}", is_shell=True, command=command)
    )


@pytest.mark.parametrize("command", GIT_COMMANDS)
def test_the_read_only_tier_does_not_approve_git(command: str) -> None:
    verdict = _judge(command)
    assert verdict.action != TOOL_AUTO_APPROVE, (command, verdict)


@pytest.mark.parametrize("command", ["git status", "git log --oneline -5", "ls && git diff"])
def test_a_git_read_falls_through_to_the_surface_approver(command: str) -> None:
    """Not a deny: the call reaches the surface's own approval, as any other
    unproven call does, so an attended session can still approve it by hand."""
    assert is_read_only_bash(command) is True
    verdict = _judge(command)
    assert (verdict.action, verdict.read_only) == (TOOL_ALLOW, False)


@pytest.mark.parametrize("command", ["git status", "ls && git diff"])
def test_classifier_only_does_not_approve_git_either(command: str) -> None:
    verdict = HookManager().judge(
        ToolCall(title=f"Running: {command}", is_shell=True, command=command),
        classifier_only=True,
    )
    assert verdict.action != TOOL_AUTO_APPROVE


@pytest.mark.parametrize("command", STILL_APPROVED)
def test_other_reads_still_auto_approve(command: str) -> None:
    verdict = _judge(command)
    assert (verdict.action, verdict.read_only) == (TOOL_AUTO_APPROVE, True), (command, verdict)
