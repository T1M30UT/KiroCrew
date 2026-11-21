"""The gateway's own part of a declared ``PATH`` is not part of a launch approval.

``env.spec_env_path`` appends the gateway's own ``PATH`` (plus the well-known
MCP directories) to every declared spec ``PATH``, so a re-rendered service unit
or a package installer that adds or moves a directory there changed every such
server's fingerprint and paused its share. The approval hash folds that part
(``hashing.hash_launch_env``); the spec's own entries still count, a ``PATH``
that is not that composition hashes as written, and the pool key is unchanged.
An approval stored before the fold is carried over without a prompt, both when
the gateway ``PATH`` is unchanged and when it moved (through the ``PATH`` the
approved display shows), and gatewayd accepts the old identity until the
gateway saves the folded one.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest
from mcp_launch_approval_helpers import (
    _APPROVED_CMD,
    _approval_module,
    _rewrite,
    _targets_running,
    _write_agent,
)

from kiro_crew import env as env_mod
from kiro_crew.mcp_gateway import hashing, rewriter

#: Opts this module out of the conftest fixture that approves every gatewayd launch.
ENFORCE_LAUNCH_APPROVAL = True

_OWN = os.pathsep.join(["/opt/tools/bin", "/opt/tools/sbin"])
_ARGS = ["-V"]


def _gateway_path(monkeypatch, tmp_path: Path, *names: str) -> None:
    """Point this process's PATH at fresh directories, as a re-rendered unit does."""
    dirs = []
    for name in names:
        d = tmp_path / "gw" / name
        d.mkdir(parents=True, exist_ok=True)
        dirs.append(str(d))
    monkeypatch.setenv("PATH", os.pathsep.join(dirs))


def _agent(tmp_path: Path, own: str = _OWN) -> dict[str, str]:
    env = {"PATH": env_mod.spec_env_path(own)}
    _write_agent(
        tmp_path / "agents", {"srv": {"command": _APPROVED_CMD, "args": _ARGS, "env": env}}
    )
    return env


def test_a_changed_gateway_path_keeps_the_env_fingerprint(tmp_path, monkeypatch):
    mod = _approval_module()
    _gateway_path(monkeypatch, tmp_path, "bin", "cargo")
    before = env_mod.spec_env_path(_OWN)
    folded = mod.env_fingerprint({"PATH": before})

    _gateway_path(monkeypatch, tmp_path, "sbin", "node-22.24.0")
    after = env_mod.spec_env_path(_OWN)

    assert after != before
    assert mod.env_fingerprint({"PATH": after}) == folded


def test_the_specs_own_entries_still_count(tmp_path, monkeypatch):
    mod = _approval_module()
    _gateway_path(monkeypatch, tmp_path, "bin")
    mine = mod.env_fingerprint({"PATH": env_mod.spec_env_path(_OWN)})
    other = mod.env_fingerprint({"PATH": env_mod.spec_env_path("/opt/other/bin")})
    reordered = os.pathsep.join(reversed(_OWN.split(os.pathsep)))

    assert other != mine
    assert mod.env_fingerprint({"PATH": env_mod.spec_env_path(reordered)}) != mine


def test_a_path_that_is_not_the_composition_hashes_as_written(tmp_path, monkeypatch):
    mod = _approval_module()
    _gateway_path(monkeypatch, tmp_path, "bin")
    hand = {"PATH": os.pathsep.join(["/opt/a", "/opt/b"]), "OTHER": "x"}

    assert mod.env_fingerprint(hand) == hashing.hash_declared_env(hand)
    # The same composition under another key is content, not the gateway's part.
    moved = {"TOOLS_PATH": env_mod.spec_env_path(_OWN)}
    assert mod.env_fingerprint(moved) == hashing.hash_declared_env(moved)


def test_the_pool_key_still_sees_the_real_path(tmp_path, monkeypatch):
    _gateway_path(monkeypatch, tmp_path, "bin")
    before = hashing.hash_effective_env({"PATH": env_mod.spec_env_path(_OWN)})
    _gateway_path(monkeypatch, tmp_path, "sbin")

    assert hashing.hash_effective_env({"PATH": env_mod.spec_env_path(_OWN)}) != before


def test_a_pinned_gateway_path_is_the_one_folded(tmp_path, monkeypatch):
    mod = _approval_module()
    _gateway_path(monkeypatch, tmp_path, "bin")
    value = env_mod.spec_env_path(_OWN)
    folded = mod.env_fingerprint({"PATH": value})
    pinned = env_mod.gateway_spec_path()

    # gatewayd's own PATH differs from the gateway's; it is handed the gateway's.
    _gateway_path(monkeypatch, tmp_path, "daemon")
    monkeypatch.setattr(hashing, "_PINNED_GATEWAY_PATH", None)
    assert mod.env_fingerprint({"PATH": value}) != folded
    hashing.pin_gateway_path(pinned)
    assert mod.env_fingerprint({"PATH": value}) == folded


def _approve_as_the_toggle_does(tmp_path: Path, mod, store: Path) -> None:
    probe = mod.LaunchApprovals(probe=True)
    _rewrite(tmp_path, frozenset({"srv"}), probe)
    launches = list(probe.captured_launches.get("SRV", {}).values())
    assert launches
    mod.approve({"srv": launches}, path=store)


def _rewrite_and_persist(tmp_path: Path, mod, store: Path):
    approvals = mod.load_approvals(store)
    target_env = _rewrite(tmp_path, frozenset({"srv"}), approvals)
    mod.save_pass(approvals, path=store)
    return approvals, target_env


def test_a_share_survives_a_changed_gateway_path(tmp_path, monkeypatch):
    mod = _approval_module()
    store = tmp_path / "approvals.json"
    _gateway_path(monkeypatch, tmp_path, "bin", "cargo")
    _agent(tmp_path)
    _approve_as_the_toggle_does(tmp_path, mod, store)

    _gateway_path(monkeypatch, tmp_path, "sbin")
    _agent(tmp_path)
    approvals, target_env = _rewrite_and_persist(tmp_path, mod, store)

    assert approvals.refused == {}
    assert _targets_running(target_env, _APPROVED_CMD)


def test_a_changed_own_entry_is_still_refused(tmp_path, monkeypatch):
    mod = _approval_module()
    store = tmp_path / "approvals.json"
    _gateway_path(monkeypatch, tmp_path, "bin")
    _agent(tmp_path)
    _approve_as_the_toggle_does(tmp_path, mod, store)

    _agent(tmp_path, own=os.pathsep.join(["/opt/evil/bin", _OWN]))
    approvals, target_env = _rewrite_and_persist(tmp_path, mod, store)

    assert approvals.refused.get("SRV") == mod.REFUSED_CHANGED
    assert not _targets_running(target_env, _APPROVED_CMD)


def _pre_fold_store(mod, store: Path, env: dict[str, str]) -> None:
    """A store as the release before the fold wrote it: literal hashes, clear PATH."""
    approvals = mod.LaunchApprovals()
    command_hash = rewriter.hash_command(_APPROVED_CMD, _ARGS)
    pair = mod.launch_pair(command_hash, mod.legacy_env_fingerprint(env))
    approvals.approved["SRV"] = {mod.legacy_launch_fingerprint(_APPROVED_CMD, _ARGS, env)}
    approvals.approved_pairs["SRV"] = {pair}
    approvals.names["SRV"] = "srv"
    approvals.approved_displays["SRV"] = {
        pair: (mod._bounded_display_argv((_APPROVED_CMD, _ARGS)), mod._bounded_display_env(env))
    }
    mod._write(store, mod._document(approvals, {}))


@pytest.mark.parametrize("gateway_moved", [False, True], ids=["same-path", "moved-path"])
def test_an_approval_stored_before_the_fold_is_carried(tmp_path, monkeypatch, gateway_moved):
    mod = _approval_module()
    store = tmp_path / "approvals.json"
    _gateway_path(monkeypatch, tmp_path, "bin", "cargo")
    _pre_fold_store(mod, store, _agent(tmp_path))
    if gateway_moved:
        _gateway_path(monkeypatch, tmp_path, "sbin")
    env = _agent(tmp_path)

    approvals, target_env = _rewrite_and_persist(tmp_path, mod, store)

    assert approvals.refused == {}
    assert _targets_running(target_env, _APPROVED_CMD)
    stored = mod.load_approvals(store)
    command_hash = rewriter.hash_command(_APPROVED_CMD, _ARGS)
    assert stored.admits_launch("SRV", command_hash, mod.env_fingerprint(env))
    # Once saved, a further move of the gateway's PATH needs nothing at all.
    _gateway_path(monkeypatch, tmp_path, "node-22.24.0")
    _agent(tmp_path)
    again, _ = _rewrite_and_persist(tmp_path, mod, store)
    assert again.refused == {}


def test_a_pre_fold_carry_still_needs_the_same_own_entries(tmp_path, monkeypatch):
    mod = _approval_module()
    store = tmp_path / "approvals.json"
    _gateway_path(monkeypatch, tmp_path, "bin")
    _pre_fold_store(mod, store, _agent(tmp_path))
    _gateway_path(monkeypatch, tmp_path, "sbin")
    _agent(tmp_path, own="/opt/evil/bin")

    approvals, target_env = _rewrite_and_persist(tmp_path, mod, store)

    assert approvals.refused.get("SRV") == mod.REFUSED_CHANGED
    assert not _targets_running(target_env, _APPROVED_CMD)


def test_gatewayd_accepts_a_pre_fold_identity(tmp_path, monkeypatch):
    mod = _approval_module()
    _gateway_path(monkeypatch, tmp_path, "bin")
    env = {"PATH": env_mod.spec_env_path(_OWN)}

    assert mod.env_fingerprints(env) == (
        mod.env_fingerprint(env),
        mod.legacy_env_fingerprint(env),
    )
    plain = {"TOKEN": "x"}
    assert mod.env_fingerprints(plain) == (mod.env_fingerprint(plain),)


class _SpawnCaptured(RuntimeError):
    pass


def test_the_manager_hands_gatewayd_the_gateway_path(tmp_path, monkeypatch):
    from kiro_crew.mcp_gateway.manager import GatewayManager, GatewaySpec

    _gateway_path(monkeypatch, tmp_path, "bin")
    expected = env_mod.gateway_spec_path()
    captured: dict = {}

    async def _fake_spawn(*_argv, env=None, **_kwargs):
        captured["env"] = dict(env or {})
        raise _SpawnCaptured

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_spawn)
    manager = GatewayManager(GatewaySpec(socket_path=tmp_path / "gateway.sock"))
    monkeypatch.setattr(manager, "_gatewayd_log_path", lambda: tmp_path / "gatewayd.stdout")
    monkeypatch.setattr(manager, "_credential_watch_paths", lambda: [])
    with pytest.raises(_SpawnCaptured):
        asyncio.run(manager._spawn_once())

    assert captured["env"][hashing.GATEWAY_PATH_ENV] == expected
