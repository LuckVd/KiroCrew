from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from kiro_crew.discord.auto_thread_store import DiscordAutoThreadStore
from kiro_crew.discord.client import DiscordInbound
from kiro_crew.discord.transport import DiscordTransport
from kiro_crew.messaging.transport import InboundMessage


class _FakeDiscordClient:
    def __init__(self) -> None:
        self.thread_channels: set[str] = set()
        self.created_threads: list[tuple[str, str, str]] = []
        self.still_permitted = None

    async def create_thread_from_message(self, channel_id: str, message_id: str, name: str) -> str:
        thread_id = f"thread-{message_id}"
        self.created_threads.append((channel_id, message_id, name))
        self.thread_channels.add(thread_id)
        return thread_id

    async def is_thread_channel(self, channel_id: str) -> bool:
        return channel_id in self.thread_channels


class TestDiscordAutoThreadAuthorization:
    @pytest.mark.asyncio
    async def test_created_thread_is_restored_only_while_parent_is_allowed(
        self, tmp_path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        events: list[dict[str, Any]] = []
        monkeypatch.setattr(
            "kiro_crew.discord.transport.sel",
            lambda: SimpleNamespace(log_api_access=lambda **kwargs: events.append(kwargs)),
        )
        store_path = tmp_path / "trust" / "discord_auto_threads.json"
        store = DiscordAutoThreadStore(store_path)
        first_dispatched: list[InboundMessage] = []

        async def _dispatch_first(message: InboundMessage) -> None:
            first_dispatched.append(message)

        first = DiscordTransport(
            _FakeDiscordClient(),  # type: ignore[arg-type]
            allowed_user_ids=["user-1"],
            allowed_channel_ids=["channel-1"],
            persist_auto_thread=store.record,
            dispatch=_dispatch_first,
        )
        await first.receive(
            DiscordInbound(
                channel_id="channel-1",
                user_id="user-1",
                text="Start here",
                message_id="message-1",
                guild_id="guild-1",
            )
        )
        thread_id = first_dispatched[0].conversation_id

        restarted_store = DiscordAutoThreadStore(store_path)
        restored = await asyncio.to_thread(restarted_store.load, {"channel-1"})
        assert restored == {thread_id: "channel-1"}

        restarted_dispatched: list[InboundMessage] = []

        async def _dispatch_restarted(message: InboundMessage) -> None:
            restarted_dispatched.append(message)

        restarted_client = _FakeDiscordClient()
        restarted_client.thread_channels.add(thread_id)
        restarted = DiscordTransport(
            restarted_client,  # type: ignore[arg-type]
            allowed_user_ids=["user-1"],
            allowed_channel_ids=["channel-1"],
            auto_thread_ids=restored,
            dispatch=_dispatch_restarted,
        )
        restarted.reconfigure(
            SimpleNamespace(
                allowed_user_ids=["user-1"],
                allowed_thread_ids=[],
                allowed_channel_ids=["channel-1"],
                auto_thread=True,
            )
        )
        await restarted.receive(
            DiscordInbound(
                channel_id=thread_id,
                user_id="user-1",
                text="Still here after restart",
                message_id="message-2",
                guild_id="guild-1",
            )
        )
        assert [message.conversation_id for message in restarted_dispatched] == [thread_id]

        events.clear()
        revoked_ids = await asyncio.to_thread(restarted_store.load, {"other-channel"})
        revoked_dispatched: list[InboundMessage] = []

        async def _dispatch_revoked(message: InboundMessage) -> None:
            revoked_dispatched.append(message)

        revoked_client = _FakeDiscordClient()
        revoked_client.thread_channels.add(thread_id)
        revoked = DiscordTransport(
            revoked_client,  # type: ignore[arg-type]
            allowed_user_ids=["user-1"],
            allowed_channel_ids=["other-channel"],
            auto_thread_ids=revoked_ids,
            dispatch=_dispatch_revoked,
        )
        await revoked.receive(
            DiscordInbound(
                channel_id=thread_id,
                user_id="user-1",
                text="Parent is no longer allowed",
                message_id="message-3",
                guild_id="guild-1",
            )
        )
        assert revoked_dispatched == []
        assert [event["outcome"] for event in events] == ["denied_unapproved_thread"]

    @pytest.mark.asyncio
    async def test_persistence_failure_does_not_grant_the_created_thread(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        events: list[dict[str, Any]] = []
        monkeypatch.setattr(
            "kiro_crew.discord.transport.sel",
            lambda: SimpleNamespace(log_api_access=lambda **kwargs: events.append(kwargs)),
        )

        async def _fail_persist(_thread_id: str, _parent_id: str) -> None:
            raise OSError("store unavailable")

        dispatched: list[InboundMessage] = []

        async def _dispatch(message: InboundMessage) -> None:
            dispatched.append(message)

        transport = DiscordTransport(
            _FakeDiscordClient(),  # type: ignore[arg-type]
            allowed_user_ids=["user-1"],
            allowed_channel_ids=["channel-1"],
            persist_auto_thread=_fail_persist,
            dispatch=_dispatch,
        )
        await transport.receive(
            DiscordInbound(
                channel_id="channel-1",
                user_id="user-1",
                text="Start here",
                message_id="message-1",
                guild_id="guild-1",
            )
        )

        assert dispatched == []
        assert transport._allowed_threads == set()
        assert [event["outcome"] for event in events] == ["thread_authorization_persist_failed"]
