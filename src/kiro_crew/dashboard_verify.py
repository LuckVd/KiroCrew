"""Run an agent-written dashboard page once, offline, over its crewmate's real data.

An agent composes a page for a crewmate without being able to open it: it sees sample
data, the crewmate's record is what the page will really draw, and a page that works on
the first can throw on the second. The person then meets an error instead of a page.
:func:`verify_page` closes that gap while the agent is still composing. The gateway
renders the page the way the frame does, in a headless browser on this machine, and
reports every script error and where it was thrown, so the agent fixes the page before
anyone is asked to look at it.

What runs
---------
The document is :func:`kiro_crew.dashboard_frame.compose` over the read the caller
supplies, so the page sees the same ``window.kirocrew``, the same bindings and the same
Content-Security-Policy it gets in the tab. It is served as ``Content-Security-Policy:
sandbox allow-scripts``, the flags the tab mounts the frame with: an opaque origin, no
storage, no dialogs, no navigation of the top window.

Only the first paint is checked. A refill that arrives later, another locale and a
different viewport are not exercised, and a library the page loads from the CDN
allowlist is not fetched (see below), so what this reports is a floor: an error here is
a real one for the person, and silence is not a promise.

No data leaves the machine
--------------------------
The page holds real numbers out of the crew log, so the run closes every way out and
does not rely on one of them:

* the frame's own policy: ``connect-src 'none'``, ``default-src 'none'``, no ``img-src``
  beyond ``data:`` and ``blob:``, ``form-action 'none'``, ``frame-src 'none'``;
* a request filter in the browser (the DevTools ``Fetch`` domain): the page document is
  the only request answered, every other one the page makes is failed before it reaches
  the network. That includes the two CDN origins the policy allows, so a library the page
  loads from there is NOT fetched and a script that needs it fails with its name
  undefined. The filter sees the page's own requests, not a worker's; the policy refuses
  a worker from a ``blob:`` URL, the only kind the page could build, and a worker script
  from a CDN origin finds no network to load from (the two layers below);
* no name resolves (``--host-resolver-rules``) and every connection goes to a closed
  local port (``--proxy-server``, loopback not exempted);
* WebRTC is switched off by flag and its constructors are removed before the page runs,
  because a CSP does not govern it.

The DevTools connection is an inherited pipe, not a port: nothing listens, so no other
process on the host can attach to a browser that holds the crewmate's data. The browser
runs with its own sandbox on, a throwaway profile, a scrubbed environment and a wall
clock limit, and the whole process group is killed at the end. A host whose browser
cannot start its sandbox gets ``skipped``; the sandbox is never turned off. A browser
that exits while starting is remembered for :data:`_UNUSABLE_SECONDS`, so a host that
cannot run it pays the wait once rather than on every save.

A library the page loads
------------------------
Because nothing is fetched, a page that draws with Chart.js or D3 runs here without the
library, and its script stops at the library's name (``ReferenceError: Chart is not
defined``) with the rest of that script unrun. That is the run's doing and not the
page's, so it does not make the page ``failed``: when it is the only error the result is
``skipped`` and says so, and when the page has other errors those are reported and the
name is listed in a note (see :func:`_split_missing_library`).

Which browser
-------------
Only one an administrator installed (see :func:`find_browser`), started by a Python an
administrator installed (:func:`find_launcher_python`). The browser runs outside the
agent's OS sandbox and a save is the agent's to trigger, so a build the agent could
write, such as a Playwright cache in the user's home, would let the agent choose the
program the gateway runs. That rule is why the check runs on Linux only: ``/Applications``
on macOS is group-writable by every administrator account, so no browser installed there
can pass it.

What the agent reads back
-------------------------
Error text is returned to the agent that wrote the page, and it can quote what the page
was given: ``console.error(JSON.stringify(window.kirocrew))`` returns up to
:data:`MAX_ERRORS` messages of :data:`MAX_MESSAGE_CHARS` characters of the crewmate's own
values. They are values the tab would show the person, already masked and redacted by the
read the page is composed from, and the run happens only where the crewmate's page may
run script, which is where its agent already has unrestricted network access. URLs in
messages lose their query string, so a page that builds a URL out of its data does not
have it echoed.

Result
------
:class:`Verification` has a status of ``passed``, ``failed`` or ``skipped``. A skip is
not a failure and says why in ``reason``: no browser, an unsupported platform, a browser
that would not start, a run that could not get the browser in time, or a page whose
script stopped at a library the run could not fetch. Nothing in here
raises: the caller is a save that must not fail because a check could not run.
"""

from __future__ import annotations

import base64
import dataclasses
import json
import logging
import os
import re
import selectors
import shutil
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Final
from urllib.parse import urlsplit

from kiro_crew import dashboard_frame, github_runner, platform_compat
from kiro_crew.browser_cli.launcher import _SANDBOX_MARKERS

logger = logging.getLogger(__name__)

__all__ = [
    "RUN_TIMEOUT_SECONDS",
    "STATUS_FAILED",
    "STATUS_PASSED",
    "STATUS_SKIPPED",
    "PageError",
    "Verification",
    "find_browser",
    "verify_page",
]

STATUS_PASSED: Final[str] = "passed"
STATUS_FAILED: Final[str] = "failed"
STATUS_SKIPPED: Final[str] = "skipped"

#: How long the browser gets to start and be handed the page. A clean run takes about a
#: second in all; the page then has :data:`_LOAD_SECONDS` of its own to finish loading.
#: The worst case adds up to 25 seconds at most (the wait for the browser slot, this, the
#: page's own budget with its settle time and grace, the wait for an exit and the kill),
#: which stays inside the 30 seconds the MCP tool waits for a gateway reply. A test sums
#: these constants.
RUN_TIMEOUT_SECONDS: Final[float] = 8.0

#: How long after the load event the page may still raise errors from timers and
#: promises. Long enough for a ``setTimeout(0)`` chain and the frame's own readiness
#: beacon, short enough to be invisible next to the browser's start.
_SETTLE_SECONDS: Final[float] = 0.5

#: How long the page gets to fire its load event before the run calls it hung.
_LOAD_SECONDS: Final[float] = 6.0

#: How long a save waits for the single browser slot before it gives up on its check.
_LOCK_WAIT_SECONDS: Final[float] = 3.0

#: How long a browser that exited while starting is not tried again.
_UNUSABLE_SECONDS: Final[float] = 900.0

#: How long the replies to the last commands get after the page has had its time.
_GRACE_SECONDS: Final[float] = 1.0

#: How long a browser that may have exited is given to show it, and how long the kill
#: gets to take effect. Both are only spent when something has already gone wrong.
_EXIT_WAIT_SECONDS: Final[float] = 1.0
_REAP_SECONDS: Final[float] = 3.0

#: Errors kept per run. A page that throws in a loop would otherwise fill the reply.
MAX_ERRORS: Final[int] = 8

#: Distinct errors remembered, so that one that repeats is counted once. Past it a new
#: error is counted every time it arrives.
_MAX_SEEN: Final[int] = MAX_ERRORS * 8

#: Characters of one error message sent back.
MAX_MESSAGE_CHARS: Final[int] = 300

#: Characters kept of one refused URL, and how many URLs are kept. The page chooses
#: both, so both are bounded where they are stored.
_MAX_URL_CHARS: Final[int] = 300
_MAX_BLOCKED_URLS: Final[int] = 20

#: Largest single DevTools message kept. A page can make the browser send an arbitrarily
#: large one (a huge ``console.error`` argument); the rest of such a message is read and
#: thrown away, so the gateway holds at most this plus one read of it. A message dropped
#: this way was not inspected, and the run says so rather than passing the page.
_MAX_MESSAGE_BYTES: Final[int] = 4 * 1024 * 1024

#: Bytes taken from the pipe in one read.
_READ_CHUNK_BYTES: Final[int] = 64 * 1024

#: Largest composed document the run will carry through the pipe.
_MAX_DOCUMENT_BYTES: Final[int] = 16 * 1024 * 1024

#: The one URL the browser answers. Reserved TLD, so it can never resolve.
_PAGE_URL: Final[str] = "https://dashboard.invalid/page"

_VIEWPORT: Final[dict[str, Any]] = {
    "width": 1280,
    "height": 800,
    "deviceScaleFactor": 1,
    "mobile": False,
}

#: Served with the page so the document behaves as the tab's frame does: an opaque
#: origin, scripts allowed, nothing else. The page's own policy comes from its meta tag.
_RESPONSE_HEADERS: Final[tuple[tuple[str, str], ...]] = (
    ("Content-Type", "text/html; charset=utf-8"),
    ("Content-Security-Policy", "sandbox allow-scripts"),
    ("Cache-Control", "no-store"),
)

#: Run before any page script. WebRTC is the one channel the page policy does not close.
_NO_EGRESS_JS: Final[str] = (
    "for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {"
    " try { Object.defineProperty(window, name, { value: undefined, configurable: false }); }"
    " catch (err) {} }"
)

#: Switches shared by every browser build. ``--no-sandbox`` is never among them.
_BROWSER_ARGS: Final[tuple[str, ...]] = (
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-extensions",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--mute-audio",
    "--metrics-recording-only",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--proxy-server=http://127.0.0.1:9",
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--js-flags=--max-old-space-size=512",
)

#: Runs in the child between fork and exec, as a fresh interpreter rather than a
#: ``preexec_fn``, which is not safe in a process with threads. DevTools over a pipe
#: reads commands on descriptor 3 and writes replies on 4; the parent's pipe ends are
#: copied there. Duplicated above 10 first so that an end that already sits on 3 or 4
#: is not overwritten before it is copied.
_LAUNCHER: Final[str] = (
    "import fcntl, os, sys\n"
    "r, w = int(sys.argv[1]), int(sys.argv[2])\n"
    "a = fcntl.fcntl(r, fcntl.F_DUPFD, 10)\n"
    "b = fcntl.fcntl(w, fcntl.F_DUPFD, 10)\n"
    "os.dup2(a, 3)\n"
    "os.dup2(b, 4)\n"
    "for fd in {r, w, a, b} - {3, 4}:\n"
    "    os.close(fd)\n"
    "os.execv(sys.argv[3], sys.argv[3:])\n"
)

#: One browser at a time. The machine runs other work, and two Chromiums at once is the
#: easiest way to make a save slow.
_RUN_LOCK = threading.Lock()

#: ``browser path -> (when, why)`` for a browser that exited while starting. Read and
#: written only under :data:`_RUN_LOCK`.
_UNUSABLE: dict[str, tuple[float, str]] = {}


@dataclasses.dataclass(frozen=True)
class PageError:
    """One error the page raised.

    ``kind`` is ``exception`` (uncaught), ``rejection`` (unhandled promise), ``console``
    (the page's own ``console.error`` or failed ``console.assert``), ``csp`` (the frame
    refused something the page tried), ``oversize`` (a message too large to inspect),
    ``timeout`` or ``crash``. ``line`` and ``column``
    are 1-based positions inside the page's own HTML, or ``None`` when the error did not
    come from the page's markup.
    """

    kind: str
    message: str
    line: int | None = None
    column: int | None = None

    def wire(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "message": self.message,
            "line": self.line,
            "column": self.column,
        }


@dataclasses.dataclass(frozen=True)
class Verification:
    """The outcome of one run. See the module docstring for what each status means."""

    status: str
    errors: tuple[PageError, ...] = ()
    #: Why the run was skipped. Empty for the other two statuses.
    reason: str = ""
    #: Facts the reader needs to weigh the result, such as the requests that were refused.
    notes: tuple[str, ...] = ()
    #: Errors past :data:`MAX_ERRORS` that were counted and not kept.
    omitted: int = 0
    elapsed_ms: int = 0

    def wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "status": self.status,
            "errors": [error.wire() for error in self.errors],
            "reason": self.reason,
            "notes": list(self.notes),
        }
        if self.omitted:
            out["omitted"] = self.omitted
        return out


def _skipped(reason: str, started: float) -> Verification:
    logger.info("dashboard verification skipped: %s", reason)
    return Verification(STATUS_SKIPPED, reason=reason, elapsed_ms=_ms_since(started))


def _ms_since(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


# --------------------------------------------------------------------------- #
# which browser
# --------------------------------------------------------------------------- #

#: Install locations of a system browser: the real executable, never a wrapper script or a
#: link to one, because the provenance check below refuses a link. Fixed paths, never a
#: ``PATH`` lookup.
_SYSTEM_BROWSERS: Final[tuple[str, ...]] = (
    "/opt/google/chrome/chrome",
    "/usr/lib/chromium/chromium",
    "/usr/lib/chromium-browser/chromium-browser",
    "/usr/lib64/chromium-browser/chromium-browser",
    "/opt/microsoft/msedge/msedge",
)

#: Where an administrator-installed Python lives. The launcher that places the DevTools
#: pipe on descriptors 3 and 4 runs under one, and under no other: the gateway's own
#: interpreter often sits in a virtualenv the agent can write, and what the launcher
#: execs is only as trustworthy as the program that execs it.
_SYSTEM_PYTHONS: Final[tuple[str, ...]] = ("/usr/bin/python3",)


def find_browser() -> str | None:
    """A browser this gateway may run, or ``None``.

    Only one that the agent could not have put there: root-owned, not a link, and not
    writable by this account through any parent
    (``validate_provider_executable(..., require_protected=True)``). The browser runs
    OUTSIDE the agent's OS sandbox with the crewmate's data in hand, and a save is the
    agent's to trigger, so a user-owned build such as one in a Playwright cache the agent
    can write would let it run a program of its own choosing with the gateway's reach.
    That leaves browsers an administrator installed, which is why this is the whole list.
    """
    for candidate in _SYSTEM_BROWSERS:
        if not os.path.isfile(candidate):
            continue
        try:
            return github_runner.validate_provider_executable(candidate, require_protected=True)
        except Exception:
            logger.debug("browser candidate refused: %s", candidate, exc_info=True)
    return None


def find_launcher_python() -> str | None:
    """A Python this gateway may run to start the browser, or ``None``.

    Held to the same bar as the browser (:func:`find_browser`): root-owned, not a link,
    not writable by this account. A link such as ``/usr/bin/python3`` is resolved first,
    and it is the resolved file that is checked and run.
    """
    for candidate in _SYSTEM_PYTHONS:
        if not os.path.isfile(candidate):
            continue
        try:
            return github_runner.validate_provider_executable(
                os.path.realpath(candidate), require_protected=True
            )
        except Exception:
            logger.debug("launcher interpreter refused: %s", candidate, exc_info=True)
    return None


# --------------------------------------------------------------------------- #
# the page and where its lines land
# --------------------------------------------------------------------------- #


@dataclasses.dataclass(frozen=True)
class _Document:
    """The composed document and where the page's own markup starts inside it."""

    html: str
    #: Zero-based line of the composed document on which the page's first line sits.
    first_line: int
    #: Lines the page occupies.
    page_lines: int

    def locate(self, line: int | None, column: int | None) -> tuple[int | None, int | None]:
        """A browser position (zero-based, in the composed document) as a position in the
        page's own HTML (one-based), or ``(None, None)`` when it is outside the page."""
        if line is None:
            return None, None
        relative = line - self.first_line
        if not 0 <= relative < self.page_lines:
            return None, None
        return relative + 1, (column + 1) if column is not None and column >= 0 else None


def _compose(page_html: str, read: Mapping[str, Any]) -> _Document:
    document = dashboard_frame.compose(page_html, read)
    # The page is placed between two host scripts on lines of its own, so its first line
    # is the one after the `</script>` that precedes it.
    anchor = f"</script>\n{page_html}\n<script>"
    index = document.find(anchor)
    if index < 0:
        return _Document(document, -1, 0)
    start = index + len("</script>\n")
    return _Document(document, document.count("\n", 0, start), page_html.count("\n") + 1)


# --------------------------------------------------------------------------- #
# DevTools over a pipe
# --------------------------------------------------------------------------- #


class _BrowserGone(Exception):
    """The browser closed the pipe or never answered inside the run's deadline.

    ``failed_to_start`` is set when it exited before answering its first command, which
    is a property of the host and not of the page.
    """

    def __init__(self, message: str, *, failed_to_start: bool = False) -> None:
        super().__init__(message)
        self.failed_to_start = failed_to_start


class _CdpError(Exception):
    """The browser answered a command with an error."""


class _Pipe:
    """DevTools messages over two inherited pipes: JSON objects separated by NUL bytes."""

    def __init__(self, to_browser: int, from_browser: int) -> None:
        self._out = to_browser
        self._in = from_browser
        os.set_blocking(self._out, False)
        os.set_blocking(self._in, False)
        self._selector = selectors.DefaultSelector()
        self._buffer = b""
        #: True while the tail of an oversize message is being read and dropped.
        self._discarding = False
        #: How many oversize messages were dropped.
        self.dropped = 0
        self._next_id = 0
        self.on_event: Callable[[dict[str, Any]], None] = lambda _message: None

    def close(self) -> None:
        """Release the selector. The descriptors belong to the caller, which closes each
        one exactly once."""
        self._selector.close()

    def _wait(self, fd: int, event: int, deadline: float) -> bool:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        self._selector.register(fd, event)
        try:
            return bool(self._selector.select(remaining))
        finally:
            self._selector.unregister(fd)

    def send(
        self, method: str, params: Mapping[str, Any] | None, session: str | None, deadline: float
    ) -> int:
        self._next_id += 1
        message: dict[str, Any] = {"id": self._next_id, "method": method, "params": params or {}}
        if session:
            message["sessionId"] = session
        data = json.dumps(message, separators=(",", ":")).encode("utf-8") + b"\0"
        view = memoryview(data)
        while view:
            try:
                written = os.write(self._out, view)
            except BlockingIOError:
                if not self._wait(self._out, selectors.EVENT_WRITE, deadline):
                    raise _BrowserGone("the browser stopped reading commands") from None
                continue
            except OSError as exc:
                raise _BrowserGone(f"the browser closed its command pipe ({exc.strerror})") from exc
            view = view[written:]
        return self._next_id

    def receive(self, deadline: float) -> dict[str, Any] | None:
        """The next message, or ``None`` when *deadline* passes first."""
        while True:
            end = self._buffer.find(b"\0")
            if end >= 0:
                raw, self._buffer = self._buffer[:end], self._buffer[end + 1 :]
                if self._discarding:
                    self._discarding = False
                    continue
                try:
                    message = json.loads(raw)
                except ValueError:
                    logger.debug("dropped an unreadable DevTools message")
                    continue
                if isinstance(message, dict):
                    return message
                continue
            if self._discarding or len(self._buffer) > _MAX_MESSAGE_BYTES:
                if not self._discarding:
                    self.dropped += 1
                self._discarding = True
                self._buffer = b""
            if not self._wait(self._in, selectors.EVENT_READ, deadline):
                return None
            try:
                chunk = os.read(self._in, _READ_CHUNK_BYTES)
            except BlockingIOError:
                continue
            except OSError as exc:
                raise _BrowserGone(f"the browser closed its reply pipe ({exc.strerror})") from exc
            if not chunk:
                raise _BrowserGone("the browser exited")
            self._buffer += chunk

    def call(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        session: str | None = None,
        deadline: float,
    ) -> dict[str, Any]:
        """Send one command and wait for its reply. Events that arrive meanwhile are
        handed to :attr:`on_event`, so a request the page makes while this waits is
        still answered."""
        wanted = self.send(method, params, session, deadline)
        while True:
            message = self.receive(deadline)
            if message is None:
                raise _BrowserGone(f"the browser did not answer {method} in time")
            if message.get("id") == wanted:
                error = message.get("error")
                if error:
                    raise _CdpError(f"{method}: {error.get('message', error)}")
                result = message.get("result")
                return result if isinstance(result, dict) else {}
            if "id" not in message:
                self.on_event(message)


# --------------------------------------------------------------------------- #
# what the page said
# --------------------------------------------------------------------------- #


@dataclasses.dataclass(frozen=True)
class _Raw:
    kind: str
    message: str
    line: int | None = None
    column: int | None = None


def _clip(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= MAX_MESSAGE_CHARS else text[: MAX_MESSAGE_CHARS - 1] + "\u2026"


def _without_queries(text: str) -> str:
    """*text* with the query and fragment cut off every URL in it. A page that builds a
    URL out of its data would otherwise have that data echoed back in an error."""
    return re.sub(r"(https?://[^\s'\"?#]+)[?#][^\s'\"]*", r"\1", text)


def _message(text: str) -> str:
    """Page-controlled *text* as the agent reads it: no URL query, one line, clipped."""
    return _clip(_without_queries(text))


def _first_frame(stack: Any) -> tuple[int | None, int | None, str]:
    frames = stack.get("callFrames") if isinstance(stack, Mapping) else None
    if isinstance(frames, list) and frames and isinstance(frames[0], Mapping):
        top = frames[0]
        return top.get("lineNumber"), top.get("columnNumber"), str(top.get("url") or "")
    return None, None, ""


#: Hosts the frame's policy lets a page load scripts from.
_SCRIPT_HOSTS: Final[tuple[str, ...]] = tuple(
    origin.split("://", 1)[1] for origin in dashboard_frame.RESOURCE_ORIGINS
)

#: What the browser says when a script names a global that nothing defined, as the first
#: thing in an uncaught error or a ``console.error``.
_UNDEFINED_NAME: Final[re.Pattern[str]] = re.compile(
    r"^(?:console\.error: )?ReferenceError: ([\w$]+) is not defined\b"
)


#: Globals a library defines that its URL does not spell.
_LIBRARY_ALIASES: Final[dict[str, tuple[str, ...]]] = {
    "$": ("jquery",),
    "_": ("lodash", "underscore"),
    "L": ("leaflet",),
    "hljs": ("highlight",),
}

#: Path words the two CDNs put in front of every library, which name none.
_URL_FILLER: Final[frozenset[str]] = frozenset(
    {"npm", "gh", "ajax", "libs", "lib", "dist", "build", "umd", "min", "js", "css", "files"}
)


def _is_library_url(url: str) -> bool:
    try:
        return urlsplit(url).hostname in _SCRIPT_HOSTS
    except ValueError:
        return False


def _defined_by(name: str, url: str) -> bool:
    """Whether the library at *url* plausibly defines the global *name*.

    Read from the URL alone, because nothing was fetched: ``Chart`` for ``.../chart.js@4``,
    ``d3`` for ``.../d3/7.8.5/d3.min.js``, ``ReactDOM`` for ``.../react-dom``. A name the
    URL does not suggest is the page's own, so a typo on a page that loads a library is
    still reported.
    """
    words = [
        word
        for word in re.sub(r"[^a-z0-9]+", " ", urlsplit(url).path.lower()).split()
        if word not in _URL_FILLER
    ]
    words += [a + b for a, b in zip(words, words[1:])]
    return any(
        word == wanted or (len(wanted) >= 4 and word.startswith(wanted))
        for wanted in _LIBRARY_ALIASES.get(name) or (name.lower(),)
        for word in words
    )


class _Collector:
    """Turns DevTools events into the errors a page author can act on."""

    def __init__(self) -> None:
        self.errors: list[_Raw] = []
        self.omitted = 0
        self.blocked: list[str] = []
        #: Distinct-or-not requests refused past :data:`_MAX_BLOCKED_URLS`, counted so the
        #: note can say they exist.
        self.blocked_overflow = 0
        #: A script request to one of the CDN origins the frame allows was refused, so a
        #: library the page uses was never loaded; and which ones, up to
        #: :data:`_MAX_BLOCKED_URLS`.
        self.library_refused = False
        self.library_urls: list[str] = []
        #: The page document itself has been navigated to. Its load event is the one that
        #: counts: the blank page the tab starts on can finish loading first.
        self.committed = False
        self.loaded = False
        self.crashed = False
        self._seen: set[tuple[str, str, int | None]] = set()

    def refuse(self, url: str, resource_type: str) -> None:
        """Note a request that was refused. The page chooses the URL, so how many are kept
        and how long each is are bounded here."""
        kept = url[:_MAX_URL_CHARS]
        if kept not in self.blocked:
            if len(self.blocked) < _MAX_BLOCKED_URLS:
                self.blocked.append(kept)
            else:
                self.blocked_overflow += 1
        if resource_type == "Script" and _is_library_url(url):
            self.library_refused = True
            if kept not in self.library_urls and len(self.library_urls) < _MAX_BLOCKED_URLS:
                self.library_urls.append(kept)

    def add(self, raw: _Raw) -> None:
        key = (raw.kind, raw.message, raw.line)
        if key in self._seen:
            return
        if len(self._seen) < _MAX_SEEN:
            self._seen.add(key)
        if len(self.errors) >= MAX_ERRORS:
            # Counted, not kept: a page that throws without end must not grow this.
            self.omitted += 1
            return
        self.errors.append(raw)

    def on_event(self, method: str, params: Mapping[str, Any]) -> None:
        if method == "Runtime.exceptionThrown":
            self._exception(params.get("exceptionDetails") or {})
        elif method == "Runtime.consoleAPICalled":
            self._console(params)
        elif method == "Log.entryAdded":
            self._log(params.get("entry") or {})
        elif method == "Page.frameNavigated":
            frame = params.get("frame") or {}
            if frame.get("url") == _PAGE_URL and not frame.get("parentId"):
                self.committed = True
        elif method == "Page.loadEventFired":
            if self.committed:
                self.loaded = True
        elif method in ("Inspector.targetCrashed", "Target.targetCrashed"):
            self.crashed = True

    def _exception(self, details: Mapping[str, Any]) -> None:
        exception = details.get("exception") or {}
        description = exception.get("description")
        text = str(details.get("text") or "Uncaught")
        if isinstance(description, str) and description:
            message = description.split("\n", 1)[0]
        elif "value" in exception:
            message = f"{text} {exception['value']}"
        else:
            message = text
        line, column, url = _first_frame(details.get("stackTrace"))
        if line is None:
            line, column, url = (
                details.get("lineNumber"),
                details.get("columnNumber"),
                str(details.get("url") or ""),
            )
        if url and url != _PAGE_URL:
            line = column = None
        kind = "rejection" if "in promise" in text else "exception"
        self.add(_Raw(kind, _message(message), line, column))

    def _console(self, params: Mapping[str, Any]) -> None:
        if params.get("type") not in ("error", "assert"):
            return
        parts = []
        for arg in (params.get("args") or [])[:5]:
            if not isinstance(arg, Mapping):
                continue
            value = arg.get("value", arg.get("description", ""))
            parts.append(value if isinstance(value, str) else json.dumps(value, default=str))
        line, column, url = _first_frame(params.get("stackTrace"))
        if url and url != _PAGE_URL:
            line = column = None
        label = "console.assert failed" if params.get("type") == "assert" else "console.error"
        self.add(
            _Raw("console", _message(f"{label}: {' '.join(parts)}".rstrip(": ")), line, column)
        )

    def _log(self, entry: Mapping[str, Any]) -> None:
        # Only what the frame's policy refused. A script exception is also logged here,
        # but it is reported once, from the runtime event; a failed request is this run's
        # own doing and is listed as a note.
        if entry.get("source") != "security" or entry.get("level") != "error":
            return
        self.add(_Raw("csp", _message(str(entry.get("text") or "")), None, None))


def _short_url(url: str) -> str:
    url = _without_queries(url)
    return url if len(url) <= 120 else url[:119] + "\u2026"


# --------------------------------------------------------------------------- #
# the browser process
# --------------------------------------------------------------------------- #


def _spawn(
    python: str, browser: str, profile: str, commands: int, replies: int
) -> subprocess.Popen[bytes]:
    """Start the browser with DevTools reading commands on *commands* and writing
    replies on *replies*, which the launcher moves to descriptors 3 and 4.

    Fixed argv: nothing the agent wrote reaches it. The page is data delivered over the
    pipe, never a flag or a path. It starts in the throwaway profile directory, so nothing
    it reads or writes by a relative name touches the gateway's own working directory.
    """
    headless = "--headless" if "headless" in os.path.basename(browser) else "--headless=new"
    env = {"PATH": "/usr/bin:/bin", "HOME": profile, "TMPDIR": profile, "LANG": "C.UTF-8"}
    argv = [
        python,
        "-I",
        "-S",
        "-c",
        _LAUNCHER,
        str(commands),
        str(replies),
        browser,
        headless,
        f"--user-data-dir={profile}",
        *_BROWSER_ARGS,
    ]
    with open(os.path.join(profile, "stderr.log"), "wb") as stderr:
        return subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=stderr,
            env=env,
            cwd=profile,
            pass_fds=(commands, replies),
            close_fds=True,
            start_new_session=True,
        )


def _stop(proc: subprocess.Popen[bytes]) -> None:
    """Kill the browser and everything it started, then reap it.

    The group is killed while the browser is still unreaped, the one time its pid cannot
    name another process's group; this is why nothing before it reaps (:func:`_exited`).
    """
    platform_compat.kill_popen_tree(proc)
    try:
        proc.wait(timeout=_REAP_SECONDS)
    except subprocess.TimeoutExpired:
        logger.warning("the verification browser did not exit after SIGKILL")


def _exited(proc: subprocess.Popen[bytes], seconds: float) -> bool:
    """Whether *proc* has exited within *seconds*, without reaping it.

    ``wait`` would reap the browser, and the group of a browser that died mid-run could
    then not be killed, leaving its children alive with the crewmate's data in hand.
    """
    end = time.monotonic() + seconds
    while True:
        try:
            if os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                return True
        except ChildProcessError:
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(0.02)


def _path_free(text: str) -> str:
    """*text* with every absolute path cut down to its last component."""
    return re.sub(r"/(?:[^\s:'\"]+/)+([^\s:'\"/]+)", r"\1", text)


def _exit_reason(proc: subprocess.Popen[bytes], profile: str) -> str:
    """Why the browser is gone, from the last line it wrote, or ``""`` if it is alive."""
    if not _exited(proc, _EXIT_WAIT_SECONDS):
        return ""
    try:
        data = Path(profile, "stderr.log").read_bytes()[-2000:]
    except OSError:
        data = b""
    text = data.decode("utf-8", "replace")
    if any(marker in text for marker in _SANDBOX_MARKERS):
        return (
            "the browser cannot start its sandbox on this machine (it needs unprivileged "
            "user namespaces), and Kiro Crew does not turn the sandbox off"
        )
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return "the browser exited before it ran the page"
    return _clip(_path_free(re.sub(r"^\[[^\]]*\]\s*", "", lines[-1])))


class _Run:
    """One page load: the request filter, the event stream and the settle wait."""

    def __init__(self, pipe: _Pipe, document: _Document, deadline: float) -> None:
        self._pipe = pipe
        self._document = document
        self._deadline = deadline
        self._session = ""
        self._served = False
        #: Set once the browser has answered a command.
        self.started = False
        self.collector = _Collector()
        pipe.on_event = self._handle

    def _handle(self, message: Mapping[str, Any]) -> None:
        method = str(message.get("method") or "")
        params = message.get("params") or {}
        if method == "Fetch.requestPaused":
            self._answer(params)
        elif method == "Page.javascriptDialogOpening":
            self._pipe.send(
                "Page.handleJavaScriptDialog", {"accept": False}, self._session, self._deadline
            )
        else:
            self.collector.on_event(method, params)

    def _answer(self, params: Mapping[str, Any]) -> None:
        """Fulfil the page, wave through inline schemes, fail everything else."""
        request_id = params.get("requestId")
        url = str((params.get("request") or {}).get("url") or "")
        if url == _PAGE_URL and not self._served:
            self._served = True
            body = base64.b64encode(self._document.html.encode("utf-8")).decode("ascii")
            self._reply(
                "Fetch.fulfillRequest",
                {
                    "requestId": request_id,
                    "responseCode": 200,
                    "responseHeaders": [{"name": n, "value": v} for n, v in _RESPONSE_HEADERS],
                    "body": body,
                },
            )
        elif url.startswith(("data:", "blob:", "about:")):
            self._reply("Fetch.continueRequest", {"requestId": request_id})
        else:
            self.collector.refuse(url, str(params.get("resourceType") or ""))
            self._reply(
                "Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"}
            )

    def _reply(self, method: str, params: Mapping[str, Any]) -> None:
        self._pipe.send(method, params, self._session, self._deadline)

    def _pump(self, until: float, stop: Callable[[], bool]) -> None:
        while not stop():
            message = self._pipe.receive(until)
            if message is None:
                return
            if "id" not in message:
                self._handle(message)

    def execute(self) -> _Collector:
        pipe, deadline = self._pipe, self._deadline
        target = pipe.call("Target.createTarget", {"url": "about:blank"}, deadline=deadline)
        self.started = True
        attached = pipe.call(
            "Target.attachToTarget",
            {"targetId": target["targetId"], "flatten": True},
            deadline=deadline,
        )
        self._session = str(attached["sessionId"])
        for method, params in (
            ("Page.enable", {}),
            ("Runtime.enable", {}),
            ("Log.enable", {}),
            ("Emulation.setDeviceMetricsOverride", _VIEWPORT),
            ("Page.addScriptToEvaluateOnNewDocument", {"source": _NO_EGRESS_JS}),
            ("Fetch.enable", {"patterns": [{"urlPattern": "*"}]}),
        ):
            pipe.call(method, params, session=self._session, deadline=deadline)
        navigated = pipe.call(
            "Page.navigate", {"url": _PAGE_URL}, session=self._session, deadline=deadline
        )
        if navigated.get("errorText"):
            raise _BrowserGone(f"the browser refused to load the page ({navigated['errorText']})")
        collector = self.collector
        # The page has its own budget. A browser that was slow to start must not be
        # charged to the page as a script that never returned.
        self._deadline = time.monotonic() + _LOAD_SECONDS + _SETTLE_SECONDS + _GRACE_SECONDS
        self._pump(
            time.monotonic() + _LOAD_SECONDS,
            lambda: collector.loaded or collector.crashed,
        )
        if collector.loaded:
            self._pump(time.monotonic() + _SETTLE_SECONDS, lambda: collector.crashed)
        if pipe.dropped:
            collector.add(
                _Raw(
                    "oversize",
                    f"the page made the browser send {pipe.dropped} message(s) over "
                    f"{_MAX_MESSAGE_BYTES // 1024} KiB, which were not inspected "
                    "(a very large console.error or thrown value)",
                )
            )
        return collector


def _drive(python: str, browser: str, document: _Document, deadline: float) -> _Collector:
    """Load the document in *browser* and collect what the page raises.

    Each descriptor is closed exactly once, by this function: a number closed twice can
    by then belong to another thread's file.
    """
    profile = tempfile.mkdtemp(prefix="kirocrew-verify-")
    owned: set[int] = set()
    proc: subprocess.Popen[bytes] | None = None
    pipe: _Pipe | None = None
    run: _Run | None = None

    def release(fd: int) -> None:
        if fd in owned:
            owned.discard(fd)
            try:
                os.close(fd)
            except OSError:
                pass

    try:
        commands_read, commands_write = os.pipe()
        owned.update((commands_read, commands_write))
        replies_read, replies_write = os.pipe()
        owned.update((replies_read, replies_write))
        proc = _spawn(python, browser, profile, commands_read, replies_write)
        # The child holds its own copies. Ours would keep the reply pipe open after it
        # exits and hide the exit from the reader.
        release(commands_read)
        release(replies_write)
        pipe = _Pipe(commands_write, replies_read)
        run = _Run(pipe, document, deadline)
        return run.execute()
    except _BrowserGone as exc:
        reason = _exit_reason(proc, profile) if proc is not None else ""
        starting = run is None or not run.started
        raise _BrowserGone(reason or str(exc), failed_to_start=bool(reason) and starting) from None
    finally:
        if proc is not None:
            _stop(proc)
        if pipe is not None:
            pipe.close()
        for fd in list(owned):
            release(fd)
        shutil.rmtree(profile, ignore_errors=True)


# --------------------------------------------------------------------------- #
# the verdict
# --------------------------------------------------------------------------- #


def _notes(collector: _Collector) -> tuple[str, ...]:
    if not collector.blocked:
        return ()
    listed = ", ".join(_short_url(url) for url in collector.blocked[:3])
    more = len(collector.blocked) - 3 + collector.blocked_overflow
    if more > 0:
        listed += f" and {more} more"
    note = f"This check runs offline, so these requests were refused: {listed}."
    if collector.library_refused:
        note += (
            " One was a script from a CDN origin, so code that depends on it did not "
            "run and was not checked."
        )
    return (note,)


def _split_missing_library(collector: _Collector) -> tuple[list[_Raw], list[str]]:
    """The errors the page raised, and the names an unfetched library left undefined.

    A page that draws with Chart.js or D3 loads it from a CDN origin the frame allows, and
    this run fetches nothing. The script that uses the library stops at its name, and the
    rest of that script does not run. That error is the run's doing, not the page's, so it
    is taken out of the page's errors. The test is narrow on purpose: a script request to
    one of those origins was refused, the error is an undefined name raised as the first
    thing in an uncaught error or a ``console.error``, and a refused URL suggests that
    name (:func:`_defined_by`). A typo beside a library is still reported, and so is any
    other error the missing library causes. With errors omitted there are too many
    distinct ones to attribute any of them.
    """
    if not collector.library_urls or collector.omitted:
        return list(collector.errors), []
    kept: list[_Raw] = []
    missing: list[str] = []
    for raw in collector.errors:
        found = _UNDEFINED_NAME.match(raw.message)
        if found and any(_defined_by(found.group(1), url) for url in collector.library_urls):
            missing.append(found.group(1))
        else:
            kept.append(raw)
    return kept, list(dict.fromkeys(missing))


def _undefined(names: list[str]) -> str:
    shown = ", ".join(f"'{name} is not defined'" for name in names[:3])
    return shown + (f" and {len(names) - 3} more" if len(names) > 3 else "")


def _verdict(collector: _Collector, document: _Document, started: float) -> Verification:
    raws, missing = _split_missing_library(collector)
    errors = [
        PageError(raw.kind, raw.message, *document.locate(raw.line, raw.column)) for raw in raws
    ]
    if collector.crashed:
        errors.append(PageError("crash", "the page crashed the browser tab"))
    elif not collector.loaded:
        errors.append(
            PageError(
                "timeout",
                f"the page did not finish loading within {int(_LOAD_SECONDS)} seconds; "
                "a script that never returns would also freeze the tab",
            )
        )
    notes = _notes(collector)
    if missing:
        if not errors:
            # Everything the page raised came from a library this run cannot fetch, so
            # what follows that call in the same script was never run. That is not a pass,
            # and the page is not at fault, so it is not a failure either.
            return Verification(
                STATUS_SKIPPED,
                reason=(
                    "a script the page loads from a CDN origin was not fetched by this "
                    f"offline check, and the page's own script then stopped at {_undefined(missing)}"
                ),
                notes=notes,
                elapsed_ms=_ms_since(started),
            )
        notes += (
            f"Not listed above: {_undefined(missing)}, most likely because a script the page "
            "loads from a CDN origin was not fetched by this offline check.",
        )
    status = STATUS_FAILED if errors else STATUS_PASSED
    return Verification(
        status,
        tuple(errors),
        notes=notes,
        omitted=collector.omitted,
        elapsed_ms=_ms_since(started),
    )


def verify_page(
    page_html: str,
    read: Mapping[str, Any],
    *,
    timeout: float = RUN_TIMEOUT_SECONDS,
) -> Verification:
    """Run *page_html* once over *read* and report what it raised.

    *read* is the object the page receives as ``window.kirocrew``, built by
    :func:`kiro_crew.dashboard_frame.read_payload`. *page_html* must already have passed
    :func:`kiro_crew.dashboard_frame.validate_page`.

    Blocking: it starts a process and waits on it, so a caller on the event loop
    offloads it. Never raises.
    """
    started = time.monotonic()
    try:
        if not platform_compat.IS_LINUX:
            return _skipped("this check runs on Linux only", started)
        browser = find_browser()
        if browser is None:
            return _skipped(
                "no system-installed Chromium or Chrome was found on this machine (the gateway "
                "runs only a browser that this account cannot modify)",
                started,
            )
        python = find_launcher_python()
        if python is None:
            return _skipped(
                "no system-installed Python was found to start the browser (the gateway runs "
                "only a Python that this account cannot modify)",
                started,
            )
        document = _compose(page_html, read)
        if len(document.html.encode("utf-8")) > _MAX_DOCUMENT_BYTES:
            return _skipped("the page and its data are too large to run here", started)
        if not _RUN_LOCK.acquire(timeout=min(timeout, _LOCK_WAIT_SECONDS)):
            return _skipped("another page check is still running; save again in a moment", started)
        try:
            known = _UNUSABLE.get(browser)
            if known is not None and time.monotonic() - known[0] < _UNUSABLE_SECONDS:
                return _skipped(f"the browser could not start: {known[1]}", started)
            try:
                collector = _drive(python, browser, document, time.monotonic() + timeout)
            except _BrowserGone as exc:
                if exc.failed_to_start:
                    _UNUSABLE[browser] = (time.monotonic(), str(exc))
                raise
        finally:
            _RUN_LOCK.release()
        verdict = _verdict(collector, document, started)
        logger.info(
            "dashboard verification %s in %d ms (%d error(s))",
            verdict.status,
            verdict.elapsed_ms,
            len(verdict.errors),
        )
        return verdict
    except _BrowserGone as exc:
        what = "start" if exc.failed_to_start else "run the page"
        return _skipped(f"the browser could not {what}: {exc}", started)
    except Exception:
        logger.warning("dashboard verification failed to run", exc_info=True)
        return _skipped("the check could not run on this machine", started)
