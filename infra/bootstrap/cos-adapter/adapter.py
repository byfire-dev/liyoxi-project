"""Restricted COS native SDK process; stdout is one sanitized JSON value."""

import importlib.metadata
import json
import logging
import os
from pathlib import Path
import re
import sys

logging.disable(logging.CRITICAL)
OPERATIONS = {"head", "artifact.put"} | {
    f"{kind}.{verb}"
    for kind in ("lifecycle", "versioning", "encryption", "acl", "policy")
    for verb in ("get", "put")
}
MISSING = {
    "lifecycle.get": "NoSuchLifecycleConfiguration",
    "policy.get": "NoSuchBucketPolicy",
    "encryption.get": "ServerSideEncryptionConfigurationNotFoundError",
}


class Rejected(Exception):
    pass


def object_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise Rejected("COS_INPUT_INVALID")
        value[key] = item
    return value


def parse_request(raw):
    try:
        request = json.loads(raw, object_pairs_hook=object_pairs,
                             parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError):
        raise Rejected("COS_INPUT_INVALID") from None
    if not isinstance(request, dict) or set(request) - {"operation", "bucket", "configuration"}:
        raise Rejected("COS_INPUT_INVALID")
    operation, bucket = request.get("operation"), request.get("bucket")
    if (not isinstance(operation, str) or operation not in OPERATIONS
            or not isinstance(bucket, str)
            or not re.fullmatch(r"lyx-stg-(secure|asset|media|pub)-[1-9][0-9]{4,19}", bucket)):
        raise Rejected("COS_INPUT_INVALID")
    if operation.endswith(".put"):
        if not isinstance(request.get("configuration"), dict):
            raise Rejected("COS_INPUT_INVALID")
    elif "configuration" in request:
        raise Rejected("COS_INPUT_INVALID")
    return request


def check_runtime():
    if sys.version_info[:3] != (3, 11, 14):
        raise Rejected("COS_RUNTIME_UNSUPPORTED")
    if importlib.metadata.version("cos-python-sdk-v5") != "1.9.44":
        raise Rejected("COS_SDK_UNSUPPORTED")
    from qcloud_cos import CosS3Client
    if not all(callable(getattr(CosS3Client, name, None)) for name in [
            "head_bucket", "put_object", *(f"{verb}_bucket_{kind}"
            for kind in ("lifecycle", "versioning", "encryption", "acl", "policy")
            for verb in ("get", "put"))]):
        raise Rejected("COS_SDK_UNSUPPORTED")


def create_client(credentials, *, test_port=None):
    """Loopback seam exists only for imported tests; never exposed by the CLI."""
    from qcloud_cos import CosConfig, CosS3Client
    import requests
    session = requests.Session()
    session.trust_env = False
    options = dict(Region="ap-shanghai", SecretId=credentials["id"],
                   SecretKey=credentials["key"], Token=credentials.get("token"),
                   Endpoint="cos.ap-shanghai.myqcloud.com",
                   Scheme="https", Timeout=10, AllowRedirects=False,
                   AutoSwitchDomainOnRetry=False, EnableOldDomain=False,
                   EnableInternalDomain=False, VerifySSL=True)
    if test_port is not None:
        if type(test_port) is not int or not 1 <= test_port <= 65535:
            raise Rejected("COS_INPUT_INVALID")
        options.update(Scheme="http", IP="127.0.0.1", Port=test_port)
    return CosS3Client(CosConfig(**options), retry=0, session=session)


def credentials_from_environment():
    credentials = {"id": os.environ.get("LYX_COS_SECRET_ID"),
                   "key": os.environ.get("LYX_COS_SECRET_KEY")}
    if not all(isinstance(value, str) and value.strip() for value in credentials.values()):
        raise Rejected("COS_CREDENTIALS_MISSING")
    if os.environ.get("LYX_COS_SESSION_TOKEN"):
        credentials["token"] = os.environ["LYX_COS_SESSION_TOKEN"]
    return credentials


def execute(client, request, *, apply_enabled=False, artifact_upload_enabled=False):
    from qcloud_cos import CosServiceError
    operation, bucket = request["operation"], request["bucket"]
    configuration = request.get("configuration", {})
    if operation.endswith(".put") and not apply_enabled:
        raise Rejected("COS_APPLY_DISABLED")
    if operation == "artifact.put":
        key, filename = configuration.get("key"), configuration.get("file")
        if (not artifact_upload_enabled or not bucket.startswith("lyx-stg-secure-")
                or set(configuration) != {"key", "file"}
                or not isinstance(key, str)
                or not re.fullmatch(r"ci/sha-[0-9a-f]{12}/(weapp\.tar\.gz|images\.json)", key)
                or not isinstance(filename, str) or not Path(filename).is_absolute()
                or Path(filename).name != key.rsplit("/", 1)[1]
                or not Path(filename).is_file()):
            raise Rejected("COS_ARTIFACT_UPLOAD_REJECTED")
        with open(filename, "rb") as body:
            client.put_object(Bucket=bucket, Key=key, Body=body, ServerSideEncryption="AES256")
        return {}
    try:
        if operation == "head":
            client.head_bucket(Bucket=bucket)
            return {}
        kind, verb = operation.split(".")
        if verb == "get":
            result = getattr(client, f"get_bucket_{kind}")(Bucket=bucket)
            if kind == "policy":
                result = json.loads(result["Policy"], object_pairs_hook=object_pairs)
            if kind == "versioning" and result == {"VersioningConfiguration": None}:
                result = {}
            if not isinstance(result, dict):
                raise Rejected("COS_RESPONSE_INVALID")
            return result
        options = {"lifecycle": {"LifecycleConfiguration": configuration},
                   "encryption": {"ServerSideEncryptionConfiguration": configuration},
                   "policy": {"Policy": configuration}}
        if kind == "versioning":
            if configuration != {"Status": "Enabled"} or bucket.startswith("lyx-stg-pub-"):
                raise Rejected("COS_INPUT_INVALID")
            options[kind] = configuration
        if kind == "acl":
            if configuration != {"ACL": "private"}:
                raise Rejected("COS_INPUT_INVALID")
            options[kind] = configuration
        if kind == "encryption" and configuration != {
                "Rule": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}:
            raise Rejected("COS_INPUT_INVALID")
        getattr(client, f"put_bucket_{kind}")(Bucket=bucket, **options[kind])
        return {}
    except CosServiceError as error:
        if str(error.get_status_code()) == "404" and error.get_error_code() == MISSING.get(operation):
            return {}
        raise Rejected("COS_BUCKET_MISSING" if str(error.get_status_code()) == "404"
                       and error.get_error_code() == "NoSuchBucket" else "COS_REQUEST_FAILED") from None


def main():
    try:
        check_runtime()
        if sys.argv[1:] == ["--check"]:
            print(json.dumps({"value": {"sdk": "1.9.44", "python": "3.11.14"}}))
            return 0
        if sys.argv[1:]:
            raise Rejected("COS_INPUT_INVALID")
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise Rejected("COS_INPUT_INVALID")
        request = parse_request(raw)
        if request["operation"].endswith(".put") and os.environ.get("LYX_COS_APPLY_ENABLED") != "true":
            raise Rejected("COS_APPLY_DISABLED")
        client = create_client(credentials_from_environment())
        value = execute(client, request,
                        apply_enabled=os.environ.get("LYX_COS_APPLY_ENABLED") == "true",
                        artifact_upload_enabled=os.environ.get("LYX_COS_ARTIFACT_UPLOAD_ENABLED") == "true")
        print(json.dumps({"value": value}, allow_nan=False))
        return 0
    except Rejected as error:
        print(json.dumps({"error": str(error)}))
    except Exception:
        print(json.dumps({"error": "COS_REQUEST_FAILED"}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
