"""Durable authorization records for Discord auto-created threads."""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from kiro_crew.atomic_write import atomic_write
from kiro_crew.config.paths import config_dir

logger = logging.getLogger(__name__)

_STORE_NAME = "discord_auto_threads.json"
_STORE_VERSION = 1


class DiscordAutoThreadStoreError(ValueError):
    """The persisted auto-thread authorization store cannot be safely updated."""


class DiscordAutoThreadStore:
    """Persist ``thread_id -> parent_channel_id`` grants made by auto_thread.

    Startup only restores grants whose parent channel remains allow-listed. The
    store is deliberately kept under the crew home's protected ``trust/`` tree,
    and an unreadable or malformed file never grants access or gets overwritten.
    """

    def __init__(self, path: Path | None = None) -> None:
        self._path = path
        self._lock = threading.Lock()

    def _store_path(self) -> Path:
        return self._path or config_dir() / "trust" / _STORE_NAME

    def _read(self) -> dict[str, str] | None:
        try:
            path = self._store_path()
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except (OSError, UnicodeError):
            logger.warning("Discord auto-thread authorization store is unreadable", exc_info=True)
            return None

        try:
            document: Any = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Discord auto-thread authorization store is malformed")
            return None
        if (
            not isinstance(document, dict)
            or type(document.get("version")) is not int
            or document.get("version") != _STORE_VERSION
            or not isinstance(document.get("threads"), dict)
        ):
            logger.warning("Discord auto-thread authorization store has an unsupported shape")
            return None

        threads = document["threads"]
        if any(
            not isinstance(thread_id, str)
            or not thread_id.strip()
            or not isinstance(parent_id, str)
            or not parent_id.strip()
            for thread_id, parent_id in threads.items()
        ):
            logger.warning("Discord auto-thread authorization store has invalid entries")
            return None
        return dict(threads)

    def load(self, allowed_channel_ids: Iterable[str]) -> dict[str, str]:
        """Return only grants whose parent is still in the channel allow-list."""
        allowed_channels = {str(channel_id) for channel_id in allowed_channel_ids}
        with self._lock:
            threads = self._read()
        if threads is None:
            return {}
        return {
            thread_id: parent_id
            for thread_id, parent_id in threads.items()
            if parent_id in allowed_channels
        }

    def _record(self, thread_id: str, parent_channel_id: str) -> None:
        if not thread_id.strip() or not parent_channel_id.strip():
            raise DiscordAutoThreadStoreError("thread and parent channel ids must be non-empty")

        with self._lock:
            threads = self._read()
            if threads is None:
                raise DiscordAutoThreadStoreError(
                    "refusing to overwrite an unreadable auto-thread authorization store"
                )
            previous_parent = threads.get(thread_id)
            if previous_parent is not None and previous_parent != parent_channel_id:
                raise DiscordAutoThreadStoreError(
                    "auto-thread authorization already names a different parent channel"
                )
            threads[thread_id] = parent_channel_id
            payload = (
                json.dumps(
                    {"version": _STORE_VERSION, "threads": dict(sorted(threads.items()))},
                    indent=2,
                )
                + "\n"
            )
            try:
                atomic_write(
                    self._store_path(),
                    payload,
                    fsync=True,
                    restrict_to_owner=True,
                )
            except OSError as exc:
                raise DiscordAutoThreadStoreError(
                    "could not persist auto-thread authorization"
                ) from exc

    async def record(self, thread_id: str, parent_channel_id: str) -> None:
        """Persist a grant without blocking the Gateway event loop."""
        await asyncio.to_thread(self._record, thread_id, parent_channel_id)
