"""Official locked COS SDK + localhost HTTP artifacts, never cloud or WeChat."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import threading
import unittest
from urllib.parse import urlsplit

import adapter
import artifact_reader as reader

SOURCE, BUCKET = "a" * 40, "lyx-stg-secure-1250000000"
TAG = "sha-" + SOURCE[:12]


def archive(name="./app.json", kind=tarfile.REGTYPE):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as package:
        member = tarfile.TarInfo(name)
        member.type = kind
        member.linkname = "../../escape"
        content = b'{"pages":[]}'
        if kind == tarfile.REGTYPE:
            member.size = len(content)
            package.addfile(member, io.BytesIO(content))
        else:
            package.addfile(member)
    return output.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        self.server.calls.append(path)
        content = self.server.objects.get(path)
        self.send_response(200 if content is not None else 404)
        content = content if content is not None else b'<Error><Code>NoSuchKey</Code><Message>fake key</Message></Error>'
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


class ReaderTests(unittest.TestCase):
    def setUp(self):
        adapter.check_runtime()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.calls, self.server.objects = [], {}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = adapter.create_client({"id": "fake-id", "key": "fake-key"},
                                             test_port=self.server.server_port)
        self.directory = tempfile.TemporaryDirectory(prefix="lyx-reader-")
        self.path = Path(self.directory.name)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def fixture(self, content=None, **changes):
        content = archive() if content is None else content
        manifest = dict(source=SOURCE, tag=TAG, weappSha256=hashlib.sha256(content).hexdigest())
        manifest.update(changes)
        raw = json.dumps(manifest).encode()
        self.server.objects = {f"/ci/{TAG}/images.json": raw, f"/ci/{TAG}/weapp.tar.gz": content}
        return hashlib.sha256(raw).hexdigest()

    def call(self, sha):
        return reader.read_artifacts(self.client, BUCKET, SOURCE, sha, str(self.path))

    def test_real_sdk_gets_exact_two_keys_and_verified_project(self):
        sha = self.fixture()
        self.assertEqual(self.call(sha)["status"], "downloaded")
        self.assertEqual((self.path / "project/app.json").read_bytes(), b'{"pages":[]}')
        self.assertEqual(self.server.calls, [f"/ci/{TAG}/images.json", f"/ci/{TAG}/weapp.tar.gz"])
        production = adapter.create_client({"id": "fake-id", "key": "fake-key"})
        self.assertEqual(production._conf.uri(bucket=BUCKET), f"https://{BUCKET}.cos.ap-shanghai.myqcloud.com/")

    def test_mutated_manifest_red_rejected_before_archive_get(self):
        self.fixture()
        with self.assertRaisesRegex(adapter.Rejected, "MANIFEST_MISMATCH"):
            self.call("0" * 64)
        self.assertEqual(len(self.server.calls), 1)
        self.assertFalse((self.path / "project").exists())

    def test_mutated_archive_red_rejected_before_extraction(self):
        sha = self.fixture()
        self.server.objects[f"/ci/{TAG}/weapp.tar.gz"] += b"tampered"
        with self.assertRaisesRegex(adapter.Rejected, "ARCHIVE_MISMATCH"):
            self.call(sha)
        self.assertFalse((self.path / "project").exists())

    def test_missing_download_and_wrong_source_reject(self):
        sha = self.fixture(source="b" * 40)
        with self.assertRaisesRegex(adapter.Rejected, "SOURCE_INVALID"):
            self.call(sha)
        self.assertEqual(len(self.server.calls), 1)
        (self.path / "images.json").unlink()
        sha = self.fixture()
        del self.server.objects[f"/ci/{TAG}/weapp.tar.gz"]
        with self.assertRaises(Exception):
            self.call(sha)
        self.assertFalse((self.path / "project").exists())

    def test_bad_parameters_do_not_request_sdk(self):
        for bucket, source, sha in [("other-bucket", SOURCE, "0" * 64), (BUCKET, "../source", "0" * 64), (BUCKET, SOURCE, "bad")]:
            with self.assertRaises(adapter.Rejected):
                reader.read_artifacts(self.client, bucket, source, sha, str(self.path))
        self.assertEqual(self.server.calls, [])

    def test_traversal_and_links_do_not_extract(self):
        for name, kind in [("../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE), ("link", tarfile.LNKTYPE)]:
            with self.subTest(name=name, kind=kind):
                with tempfile.TemporaryDirectory(prefix="lyx-reader-unsafe-") as target:
                    sha = self.fixture(archive(name, kind))
                    with self.assertRaisesRegex(adapter.Rejected, "ARCHIVE_INVALID"):
                        reader.read_artifacts(self.client, BUCKET, SOURCE, sha, target)
                    self.assertEqual(list((Path(target) / "project").iterdir()), [])
