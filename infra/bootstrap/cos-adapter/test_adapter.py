"""Real locked SDK + loopback HTTP; no cloud account or real credentials."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

import adapter

BUCKET = "lyx-stg-secure-1250000000"
ACL_XML = (b'<AccessControlPolicy xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
           b'<Owner><ID>owner</ID></Owner><AccessControlList><Grant>'
           b'<Grantee xsi:type="CanonicalUser"><ID>owner</ID></Grantee>'
           b'<Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>')


def error_xml(code):
    return (f"<Error><Code>{code}</Code><Message>fake secret</Message>"
            "<Resource>/</Resource><RequestId>test</RequestId></Error>").encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        kind = urlsplit(self.path).query.removesuffix("=")
        self.server.calls.append((self.command, self.path, dict(self.headers), body))
        status, content = 200, b""
        if self.server.missing_bucket:
            status, content = 404, error_xml("NoSuchBucket")
        elif self.command == "PUT":
            self.server.state[kind] = body if kind != "acl" else ACL_XML
        elif self.command == "GET":
            content = self.server.state.get(kind)
            if content is None:
                code = {"lifecycle": "NoSuchLifecycleConfiguration", "policy": "NoSuchBucketPolicy",
                        "encryption": "ServerSideEncryptionConfigurationNotFoundError"}[kind]
                status, content = 404, error_xml(code)
        self.send_response(status)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("x-cos-request-id", "test-only")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    do_HEAD = do_GET = do_PUT = handle_request


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.calls, self.server.missing_bucket = [], False
        self.server.state = {"versioning": b"<VersioningConfiguration/>", "acl": ACL_XML}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = adapter.create_client({"id": "fake-id", "key": "fake-key"},
                                            test_port=self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def call(self, operation, configuration=None, **flags):
        request = {"operation": operation, "bucket": BUCKET}
        if configuration is not None:
            request["configuration"] = configuration
        return adapter.execute(self.client, adapter.parse_request(json.dumps(request)), **flags)

    def test_real_sdk_reads_are_readonly_and_missing_configuration_is_empty(self):
        self.assertEqual(self.call("head"), {})
        for kind in ("lifecycle", "versioning", "encryption", "policy"):
            self.assertEqual(self.call(f"{kind}.get"), {})
        acl = self.call("acl.get")
        self.assertEqual(acl["Owner"], {"ID": "owner"})
        self.assertEqual(acl["AccessControlList"]["Grant"], [{
            "Grantee": {"Type": "CanonicalUser", "ID": "owner"}, "Permission": "FULL_CONTROL"}])
        self.assertEqual(acl["CannedACL"], "private")
        self.assertFalse(any(call[0] == "PUT" for call in self.server.calls))

    def test_acl_group_shape_and_production_host(self):
        self.server.state["acl"] = ACL_XML.replace(
            b'<Grantee xsi:type="CanonicalUser"><ID>owner</ID></Grantee>',
            b'<Grantee xsi:type="Group"><URI>http://cam.qcloud.com/groups/global/AllUsers</URI></Grantee>')
        self.assertEqual(self.call("acl.get")["AccessControlList"]["Grant"][0]["Grantee"],
                         {"Type": "Group", "URI": "http://cam.qcloud.com/groups/global/AllUsers"})
        client = adapter.create_client({"id": "fake-id", "key": "fake-key"})
        self.assertEqual(client._conf.uri(bucket=BUCKET),
                         f"https://{BUCKET}.cos.ap-shanghai.myqcloud.com/")
        self.assertFalse(client._session.trust_env)

    def test_real_sdk_five_put_wire_payloads_and_reads(self):
        configs = {
            "lifecycle": {"Rule": [{"ID": "incoming", "Status": "Enabled", "Filter": {"Prefix": "incoming/"},
                                    "Expiration": {"Days": 3}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}}]},
            "versioning": {"Status": "Enabled"},
            "encryption": {"Rule": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]},
            "acl": {"ACL": "private"},
            "policy": {"Version": "2.0", "Statement": []},
        }
        for kind, configuration in configs.items():
            with self.subTest(kind=kind):
                self.assertEqual(self.call(f"{kind}.put", configuration, apply_enabled=True), {})
                readback = self.call(f"{kind}.get")
                wire = self.server.state[kind]
                if kind != "policy":
                    xml = ET.fromstring(wire)
                    for element in xml.iter():
                        element.tag = element.tag.rsplit("}", 1)[-1]
                if kind == "policy":
                    self.assertEqual(json.loads(wire), configuration)
                    self.assertEqual(readback, configuration)
                elif kind == "encryption":
                    self.assertEqual(xml.findtext("Rule/ApplyServerSideEncryptionByDefault/SSEAlgorithm"), "AES256")
                    self.assertEqual(readback, configuration)
                elif kind == "versioning":
                    self.assertEqual(xml.findtext("Status"), "Enabled")
                    self.assertEqual(readback, configuration)
                elif kind == "acl":
                    put = next(call for call in self.server.calls if call[0] == "PUT" and "?acl" in call[1])
                    self.assertEqual(put[2]["x-cos-acl"], "private")
                else:
                    self.assertEqual(xml.findtext("Rule/Expiration/Days"), "3")
                    self.assertEqual(xml.findtext("Rule/AbortIncompleteMultipartUpload/DaysAfterInitiation"), "7")
                    self.assertEqual(readback["Rule"][0]["Expiration"]["Days"], "3")

    def test_no_such_bucket_is_not_missing_configuration(self):
        self.server.missing_bucket = True
        for kind in ("lifecycle", "policy", "encryption"):
            with self.assertRaisesRegex(adapter.Rejected, "^COS_BUCKET_MISSING$"):
                self.call(f"{kind}.get")

    def test_default_denies_writes_and_pub_versioning(self):
        with self.assertRaisesRegex(adapter.Rejected, "^COS_APPLY_DISABLED$"):
            self.call("acl.put", {"ACL": "private"})
        request = {"operation": "versioning.put", "bucket": "lyx-stg-pub-1250000000",
                   "configuration": {"Status": "Enabled"}}
        with self.assertRaisesRegex(adapter.Rejected, "^COS_INPUT_INVALID$"):
            adapter.execute(self.client, request, apply_enabled=True)
        self.assertEqual(self.server.calls, [])

    def test_artifact_put_is_explicit_and_restricted(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "images.json"
            file.write_bytes(b'{"fake":"artifact"}')
            configuration = {"file": str(file), "key": "ci/sha-123456789abc/images.json"}
            with self.assertRaisesRegex(adapter.Rejected, "^COS_ARTIFACT_UPLOAD_REJECTED$"):
                self.call("artifact.put", configuration, apply_enabled=True)
            self.call("artifact.put", configuration, apply_enabled=True, artifact_upload_enabled=True)
            method, path, headers, body = self.server.calls[-1]
            self.assertEqual((method, path, body), ("PUT", "/ci/sha-123456789abc/images.json", file.read_bytes()))
            self.assertEqual(headers["x-cos-server-side-encryption"], "AES256")
            configuration["key"] = "final/sha-123456789abc/images.json"
            with self.assertRaisesRegex(adapter.Rejected, "^COS_ARTIFACT_UPLOAD_REJECTED$"):
                self.call("artifact.put", configuration, apply_enabled=True, artifact_upload_enabled=True)
            self.assertEqual(len(self.server.calls), 1)

    def test_cli_runtime_check_and_invalid_input_do_not_load_credentials(self):
        command = [sys.executable, str(Path(adapter.__file__))]
        result = subprocess.run(command + ["--check"], env={}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)["value"]["sdk"], "1.9.44")
        for raw, code in [('{"operation":"acl.put","bucket":"' + BUCKET + '","configuration":{"ACL":"private"}}', "COS_APPLY_DISABLED"),
                          ('{"operation":"head","bucket":"' + BUCKET + '","endpoint":"https://bad"}', "COS_INPUT_INVALID"),
                          ('{"operation":"head","bucket":"' + BUCKET + '"}', "COS_CREDENTIALS_MISSING"),
                          ('{"operation":"head","operation":"head"}', "COS_INPUT_INVALID")]:
            result = subprocess.run(command, input=raw, env={}, capture_output=True, text=True)
            self.assertEqual((result.returncode, json.loads(result.stdout)), (1, {"error": code}))
            self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
