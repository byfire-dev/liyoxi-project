"""Verify every locked artifact hash and seven-day age against public PyPI."""

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sys
from urllib.request import urlopen


def verify(path, now):
    packages, current = {}, None
    for line in path.read_text().splitlines():
        line = line.strip().removesuffix("\\").strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([a-z0-9-]+)==([0-9][a-zA-Z0-9.]*)", line)
        if match:
            current = match.groups()
            if current in packages:
                raise ValueError()
            packages[current] = set()
        else:
            match = re.fullmatch(r"--hash=sha256:([0-9a-f]{64})", line)
            if current is None or match is None:
                raise ValueError()
            packages[current].add(match[1])
    if not packages:
        raise ValueError()
    for (name, version), hashes in packages.items():
        with urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=15) as response:
            metadata = json.load(response)
        artifacts = {item["digests"]["sha256"]: item for item in metadata["urls"]}
        if not hashes or hashes - artifacts.keys():
            raise ValueError()
        for digest in hashes:
            item = artifacts[digest]
            published = datetime.fromisoformat(item["upload_time_iso_8601"].replace("Z", "+00:00"))
            if item["yanked"] or now - published < timedelta(days=7):
                raise ValueError()
    return packages


def main():
    try:
        root = Path(__file__).parent
        now = datetime.now(timezone.utc)
        runtime = verify(root / "requirements.lock", now)
        build = verify(root / "build-requirements.lock", now)
        for line in (root / "requirements.in").read_text().splitlines():
            if not line or line.startswith("#"):
                continue
            match = re.fullmatch(r"([a-z0-9-]+)==([0-9][a-zA-Z0-9.]*)", line)
            if match is None or match.groups() not in runtime:
                raise ValueError()
        total = len(runtime) + len(build)
        print(json.dumps({"packages": total, "minimumDays": 7, "hashesVerified": True}))
        return 0
    except Exception:
        print(json.dumps({"error": "COS_DEPENDENCY_LOCK_INVALID"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
