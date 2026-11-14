#!/usr/bin/env python3
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_host_release_home import ValidationError, validate


class ValidateHostReleaseHomeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.home = root / "home"
        self.baseline = root / "initial-home"
        self.assertNotEqual(self.baseline, self.home)
        self.assertFalse(self.baseline.is_relative_to(self.home))
        for path in (self.home, self.baseline):
            (path / ".pi/agent/sessions").mkdir(parents=True)
            (path / ".pi/agent/db").mkdir(parents=True)
            (path / ".pi/agent/settings.json").write_text("{}\n")
            (path / ".pi/agent/sessions/sentinel.jsonl").write_text("session\n")
            (path / ".pi/agent/db/sentinel.sqlite").write_bytes(b"db sentinel")

    @staticmethod
    def serialized_store():
        # Match a real FileModelsStore write: provider -> ModelsStoreEntry -> Model.
        return json.dumps({"fixture-provider": {"models": [{
            "id": "fixture-model",
            "name": "Fixture Model",
            "api": "openai-completions",
            "provider": "fixture-provider",
            "baseUrl": "https://example.test/v1",
            "reasoning": False,
            "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 1000,
            "maxTokens": 100,
        }], "checkedAt": 1}})

    def cache(self):
        return self.home / ".pi/agent/models-store.json"

    def assert_invalid(self):
        with self.assertRaises(ValidationError):
            validate(self.home, self.baseline)

    def test_observed_cli_startup_paths_are_exact_and_preserve_sentinels(self):
        agent = self.home / ".pi/agent"
        telemetry = agent / "cache-telemetry"
        telemetry.mkdir(mode=0o700)
        (agent / "auth.json").write_bytes(b"{}")
        self.cache().write_bytes(b"{}")
        telemetry_file = telemetry / "00000000-0000-4000-8000-000000000000.jsonl"
        telemetry_file.write_bytes(b"")
        for path in (agent / "auth.json", self.cache(), telemetry_file):
            path.chmod(0o600)
        validate(self.home, self.baseline, startup_side_effects=True)
        (agent / "unexpected.txt").write_text("not allowed")
        with self.assertRaisesRegex(ValidationError, "known startup paths"):
            validate(self.home, self.baseline, startup_side_effects=True)

    def test_full_end_of_gate_acceptance_preserves_legacy_sentinels_and_cache(self):
        self.cache().write_text(self.serialized_store())
        validate(self.home, self.baseline)
        self.assertEqual((self.home / ".pi/agent/settings.json").read_text(), "{}\n")
        self.assertEqual((self.home / ".pi/agent/sessions/sentinel.jsonl").read_text(), "session\n")
        self.assertEqual((self.home / ".pi/agent/db/sentinel.sqlite").read_bytes(), b"db sentinel")
        self.assertTrue(self.cache().is_file())
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("validate_host_release_home.py")), str(self.home), str(self.baseline)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_cache_preexisting_in_baseline_is_rejected(self):
        path = self.baseline / ".pi/agent/models-store.json"
        path.write_text("{}")
        self.cache().write_text("{}")
        self.assert_invalid()

    def test_bad_json_is_rejected(self):
        self.cache().write_text("{")
        self.assert_invalid()

    def test_wrong_json_type_is_rejected(self):
        self.cache().write_text("[]")
        self.assert_invalid()

    def test_symlink_cache_is_rejected(self):
        target = self.home / "outside.json"
        target.write_text(self.serialized_store())
        self.cache().symlink_to(target)
        self.assert_invalid()

    def test_unexpected_other_path_is_rejected(self):
        self.cache().write_text(self.serialized_store())
        (self.home / ".pi/agent/unexpected.txt").write_text("not allowed")
        self.assert_invalid()

    def test_unexpected_path_outside_agent_directory_is_rejected(self):
        self.cache().write_text(self.serialized_store())
        (self.home / "outside-agent.txt").write_text("not allowed")
        with self.assertRaisesRegex(ValidationError, "HOME differs from baseline outside models-store.json"):
            validate(self.home, self.baseline)

    def test_changed_permissions_are_rejected(self):
        self.cache().write_text(self.serialized_store())
        (self.home / ".pi/agent/settings.json").chmod(0o600)
        self.assert_invalid()

    def test_modified_legacy_path_is_rejected(self):
        self.cache().write_text(self.serialized_store())
        (self.home / ".pi/agent/sessions/sentinel.jsonl").write_text("modified session\\n")
        self.assert_invalid()

    def test_empty_catalog_is_rejected_as_not_meaningful(self):
        self.cache().write_text("{}")
        self.assert_invalid()


if __name__ == "__main__":
    unittest.main()
