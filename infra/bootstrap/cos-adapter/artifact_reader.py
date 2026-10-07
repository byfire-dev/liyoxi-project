"""Private release consumer: two fixed COS objects; never signs URLs or writes cloud."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

import adapter


def parameters(bucket, source, manifest_hash, directory):
    path = Path(directory)
    if (not re.fullmatch(r"lyx-stg-secure-[1-9][0-9]{4,19}", bucket)
            or not re.fullmatch(r"[a-f0-9]{40}", source)
            or not re.fullmatch(r"[a-f0-9]{64}", manifest_hash)
            or not path.is_absolute() or path.is_symlink() or not path.is_dir()
            or any(path.iterdir())):
        raise adapter.Rejected("ARTIFACT_INPUT_INVALID")
    return path


def download(client, bucket, key, file, limit):
    response = client.get_object(Bucket=bucket, Key=key)
    stream = response["Body"].get_raw_stream()
    size, digest = 0, hashlib.sha256()
    try:
        with file.open("xb") as output:
            while chunk := stream.read(65536):
                size += len(chunk)
                if size > limit:
                    raise adapter.Rejected("ARTIFACT_SIZE_INVALID")
                digest.update(chunk)
                output.write(chunk)
    finally:
        stream.close()
    return digest.hexdigest()


def read_artifacts(client, bucket, source, manifest_hash, directory):
    path = parameters(bucket, source, manifest_hash, directory)
    tag = "sha-" + source[:12]
    manifest_file, archive = path / "images.json", path / "weapp.tar.gz"
    if download(client, bucket, f"ci/{tag}/images.json", manifest_file, 65536) != manifest_hash:
        raise adapter.Rejected("ARTIFACT_MANIFEST_MISMATCH")
    manifest = json.loads(manifest_file.read_bytes(), object_pairs_hook=adapter.object_pairs)
    if (not isinstance(manifest, dict) or manifest.get("source") != source
            or manifest.get("tag") != tag
            or not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get("weappSha256", "")))):
        raise adapter.Rejected("ARTIFACT_SOURCE_INVALID")
    if download(client, bucket, f"ci/{tag}/weapp.tar.gz", archive, 50 * 1024 * 1024) != manifest["weappSha256"]:
        raise adapter.Rejected("ARTIFACT_ARCHIVE_MISMATCH")
    project = path / "project"
    project.mkdir(mode=0o700)
    with tarfile.open(archive, "r:gz") as package:
        members, seen, total = package.getmembers(), set(), 0
        for member in members:
            name = PurePosixPath(member.name)
            total += member.size
            if (name.is_absolute() or ".." in name.parts or "\\" in member.name
                    or "\n" in member.name or name in seen
                    or not (member.isfile() or member.isdir())
                    or total > 100 * 1024 * 1024 or len(members) > 10000):
                raise adapter.Rejected("ARTIFACT_ARCHIVE_INVALID")
            seen.add(name)
        package.extractall(project, members=members, filter="data")
    return {"status": "downloaded", "source": source}


def main():
    try:
        if len(sys.argv) != 5:
            raise adapter.Rejected("ARTIFACT_INPUT_INVALID")
        parameters(*sys.argv[1:])
        adapter.check_runtime()
        secrets = Path(os.environ.get("LYX_SECRETS_DIR", "/opt/liyoxi/secrets"))
        credentials = {kind: (secrets / f"cos-secret-{kind}").read_text().strip()
                       for kind in ("id", "key")}
        if not all(credentials.values()):
            raise adapter.Rejected("COS_CREDENTIALS_MISSING")
        client = adapter.create_client(credentials)
        if not callable(getattr(client, "get_object", None)):
            raise adapter.Rejected("COS_SDK_UNSUPPORTED")
        print(json.dumps(read_artifacts(client, *sys.argv[1:])))
        return 0
    except Exception:
        print(json.dumps({"error": "ARTIFACT_READ_FAILED"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
