from __future__ import annotations

import json

import pytest

from kiro_crew.discord.auto_thread_store import (
    DiscordAutoThreadStore,
    DiscordAutoThreadStoreError,
)


class TestDiscordAutoThreadStore:
    @pytest.mark.asyncio
    async def test_records_survive_a_new_store_instance_and_parent_filter(self, tmp_path):
        path = tmp_path / "trust" / "discord_auto_threads.json"
        writer = DiscordAutoThreadStore(path)
        await writer.record("thread-1", "channel-1")
        await writer.record("thread-2", "channel-2")

        after_restart = DiscordAutoThreadStore(path)
        assert after_restart.load({"channel-1"}) == {"thread-1": "channel-1"}
        assert after_restart.load({"channel-2"}) == {"thread-2": "channel-2"}
        assert after_restart.load(set()) == {}

    @pytest.mark.asyncio
    async def test_corrupt_store_fails_closed_without_overwriting_it(self, tmp_path):
        path = tmp_path / "trust" / "discord_auto_threads.json"
        path.parent.mkdir()
        path.write_text("not json", encoding="utf-8")
        store = DiscordAutoThreadStore(path)

        assert store.load({"channel-1"}) == {}
        with pytest.raises(DiscordAutoThreadStoreError):
            await store.record("thread-1", "channel-1")
        assert path.read_text(encoding="utf-8") == "not json"

    @pytest.mark.asyncio
    async def test_thread_cannot_be_reassigned_to_another_parent(self, tmp_path):
        path = tmp_path / "trust" / "discord_auto_threads.json"
        store = DiscordAutoThreadStore(path)
        await store.record("thread-1", "channel-1")

        with pytest.raises(DiscordAutoThreadStoreError):
            await store.record("thread-1", "channel-2")
        assert json.loads(path.read_text(encoding="utf-8"))["threads"] == {"thread-1": "channel-1"}
