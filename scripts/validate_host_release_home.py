#!/usr/bin/env python3
"""Validate isolated HOME after the offline host-release CLI check."""
import json
import os
import stat
import sys
from pathlib import Path

CACHE_RELATIVE = Path(".pi/agent/models-store.json")


class ValidationError(Exception):
    pass


def inventory(root: Path) -> dict[str, tuple[str, int, bytes | str | None]]:
    entries: dict[str, tuple[str, int, bytes | str | None]] = {}
    for current, dirs, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in list(dirs) + files:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            mode = path.lstat().st_mode
            permissions = stat.S_IMODE(mode)
            if stat.S_ISLNK(mode):
                entries[relative] = ("symlink", permissions, os.readlink(path))
                if name in dirs:
                    dirs.remove(name)
            elif stat.S_ISDIR(mode):
                entries[relative] = ("directory", permissions, None)
            elif stat.S_ISREG(mode):
                entries[relative] = ("file", permissions, path.read_bytes())
            else:
                entries[relative] = ("special", permissions, None)
    return entries


def validate(home: Path, baseline: Path, require_cache: bool = True) -> None:
    cache_rel = CACHE_RELATIVE.as_posix()
    before = inventory(baseline)
    after = inventory(home)
    if cache_rel in before:
        raise ValidationError("baseline already contains models-store.json")
    if require_cache and cache_rel not in after:
        raise ValidationError("models-store.json is missing")
    if not require_cache and cache_rel in after:
        raise ValidationError("models-store.json was unexpectedly created")
    if cache_rel in after:
        cache_path = home / CACHE_RELATIVE
        if not stat.S_ISREG(cache_path.lstat().st_mode):
            raise ValidationError("models-store.json is not a regular nonsymlink file")

        try:
            catalog = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValidationError(f"models-store.json is invalid JSON: {error}") from error
        if not isinstance(catalog, dict) or not catalog:
            raise ValidationError("models-store.json must contain a nonempty provider catalog")
        for provider, entry in catalog.items():
            if not isinstance(provider, str) or not provider or not isinstance(entry, dict):
                raise ValidationError("models-store.json has an invalid provider entry")
            models = entry.get("models")
            if not isinstance(models, list) or not models:
                raise ValidationError(f"models-store.json has no models for provider {provider!r}")
            for model in models:
                if not isinstance(model, dict) or not all(
                    isinstance(model.get(field), str) and model[field]
                    for field in ("id", "name", "api")
                ):
                    raise ValidationError(f"models-store.json has an invalid model for provider {provider!r}")

    after_without_cache = {path: value for path, value in after.items() if path != cache_rel}
    if before != after_without_cache:
        raise ValidationError("HOME differs from baseline outside models-store.json")


def main() -> int:
    args = sys.argv[1:]
    require_cache = True
    if args and args[0] == "--no-cache":
        require_cache = False
        args = args[1:]
    if len(args) != 2:
        print(f"usage: {sys.argv[0]} [--no-cache] HOME BASELINE", file=sys.stderr)
        return 2
    try:
        validate(Path(args[0]), Path(args[1]), require_cache=require_cache)
    except ValidationError as error:
        print(f"invalid isolated HOME: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
