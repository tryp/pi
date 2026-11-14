#!/usr/bin/env python3
import json
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
        self.baseline = root / "baseline"
        for path in (self.home, self.baseline):
            (path / ".pi/agent/sessions").mkdir(parents=True)
            (path / ".pi/agent/db").mkdir(parents=True)
            (path / ".pi/agent/settings.json").write_text("{}\n")
            (path / ".pi/agent/sessions/sentinel.jsonl").write_text("session\n")
            (path / ".pi/agent/db/sentinel.sqlite").write_bytes(b"db sentinel")

    def cache(self):
        return self.home / ".pi/agent/models-store.json"

    def assert_invalid(self):
        with self.assertRaises(ValidationError):
            validate(self.home, self.baseline)

    def test_full_end_of_gate_acceptance_preserves_legacy_sentinels_and_cache(self):
        self.cache().write_text(json.dumps({"fixture-provider": {"models": [
            {"id": "fixture-model", "name": "Fixture Model", "api": "fixture-api"}
        ]}}))
        validate(self.home, self.baseline)
        self.assertEqual((self.home / ".pi/agent/settings.json").read_text(), "{}\n")
        self.assertEqual((self.home / ".pi/agent/sessions/sentinel.jsonl").read_text(), "session\n")
        self.assertEqual((self.home / ".pi/agent/db/sentinel.sqlite").read_bytes(), b"db sentinel")
        self.assertTrue(self.cache().is_file())

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
        target.write_text(json.dumps({"fixture-provider": {"models": [
            {"id": "fixture-model", "name": "Fixture Model", "api": "fixture-api"}
        ]}}))
        self.cache().symlink_to(target)
        self.assert_invalid()

    def test_unexpected_other_path_is_rejected(self):
        self.cache().write_text(json.dumps({"fixture-provider": {"models": [
            {"id": "fixture-model", "name": "Fixture Model", "api": "fixture-api"}
        ]}}))
        (self.home / ".pi/agent/unexpected.txt").write_text("not allowed")
        self.assert_invalid()

    def test_changed_permissions_are_rejected(self):
        self.cache().write_text(json.dumps({"fixture-provider": {"models": [
            {"id": "fixture-model", "name": "Fixture Model", "api": "fixture-api"}
        ]}}))
        (self.home / ".pi/agent/settings.json").chmod(0o600)
        self.assert_invalid()

    def test_empty_catalog_is_rejected_as_not_meaningful(self):
        self.cache().write_text("{}")
        self.assert_invalid()


if __name__ == "__main__":
    unittest.main()
