// TEST ONLY：所有私钥只在测试进程内生成，不读取现有密钥或写入文件。
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify, X509Certificate } from "node:crypto";

import forge from "node-forge";

import type { P12Material } from "../material.js";

export const TEST_PASSPHRASE = "TEST ONLY runtime material";
const keyPair = () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  return {
    publicKey: forge.pki.publicKeyFromPem(
      pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    ),
    privateKey: forge.pki.privateKeyFromPem(
      pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    ),
  };
};

export function createTestMaterial() {
  const rootKey = keyPair();
  const leafKey = keyPair();
  const root = forge.pki.createCertificate();
  root.publicKey = rootKey.publicKey;
  root.serialNumber = "01";
  root.validity.notBefore = new Date("2020-01-01T00:00:00Z");
  root.validity.notAfter = new Date("2040-01-01T00:00:00Z");
  root.setSubject([{ name: "commonName", value: "TEST ONLY root - untrusted" }]);
  root.setIssuer(root.subject.attributes);
  root.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true },
  ]);
  root.sign(rootKey.privateKey, forge.md.sha256.create());
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = leafKey.publicKey;
  leaf.serialNumber = "1234abcd";
  leaf.validity.notBefore = new Date("2026-10-01T00:00:00Z");
  leaf.validity.notAfter = new Date("2027-10-01T00:00:00Z");
  leaf.setSubject([{ name: "commonName", value: "TEST ONLY signer" }]);
  leaf.setIssuer(root.subject.attributes);
  leaf.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true },
  ]);
  leaf.sign(rootKey.privateKey, forge.md.sha256.create());
  const pack = (
    key: forge.pki.rsa.PrivateKey,
    certificates: forge.pki.Certificate[],
  ): P12Material => ({
    p12: Buffer.from(
      forge.asn1
        .toDer(
          forge.pkcs12.toPkcs12Asn1(key, certificates, TEST_PASSPHRASE, {
            algorithm: "aes256",
          }),
        )
        .getBytes(),
      "binary",
    ),
    passphrase: TEST_PASSPHRASE,
  });
  return {
    material: pack(leafKey.privateKey, [root, leaf]), // 故意让根在前，不能误取首个证书。
    mismatched: () => pack(rootKey.privateKey, [leaf]),
    missingChain: () => pack(leafKey.privateKey, [leaf]),
    leaf: new X509Certificate(forge.pki.certificateToPem(leaf)),
    root: new X509Certificate(forge.pki.certificateToPem(root)),
  };
}

type Asn1 = forge.asn1.Asn1;
export function nodes(node: Asn1 | undefined): Asn1[] {
  assert(node && Array.isArray(node.value), "ASN.1 children missing");
  return node.value;
}
export function bytes(node: Asn1 | undefined): string {
  assert(node && typeof node.value === "string", "ASN.1 bytes missing");
  return node.value;
}
const der = (node: Asn1) => Buffer.from(forge.asn1.toDer(node).getBytes(), "binary");
const oid = (node: Asn1 | undefined) => forge.asn1.derToOid(bytes(node));

/** 独立验证器：forge仅解ASN.1，摘要、RSA与X.509核验均由Node/OpenSSL内置实现。 */
export function verifyTestPdf(
  pdf: Uint8Array,
  expectedLeaf: X509Certificate,
  trustedTestRoot: X509Certificate,
) {
  const buffer = Buffer.from(pdf);
  const ranges = [
    ...buffer.toString("latin1").matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g),
  ];
  assert.equal(ranges.length, 1);
  const [start, length, second, tail] = ranges[0]!.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  assert.equal(start, 0);
  assert(length > 0 && second > length && tail > 0);
  assert.equal(second + tail, buffer.length, "unsigned trailing data");
  const contents = buffer.subarray(length, second).toString("ascii");
  assert.match(contents, /^<[0-9a-fA-F]+>$/);
  const raw = Buffer.from(contents.slice(1, -1), "hex");
  assert.equal(raw[0], 0x30);
  const lengthOctets = raw[1]! < 0x80 ? 0 : raw[1]! & 0x7f;
  assert(lengthOctets <= 4);
  const header = lengthOctets === 0 ? 2 : 2 + lengthOctets;
  const payload = lengthOctets === 0 ? raw[1]! : raw.readUIntBE(2, lengthOctets);
  assert(
    raw.subarray(header + payload).every((byte) => byte === 0),
    "nonzero CMS padding",
  );
  const cms = forge.asn1.fromDer(raw.subarray(0, header + payload).toString("binary"), true);
  const contentInfo = nodes(cms);
  assert.equal(oid(contentInfo[0]), forge.pki.oids.signedData);
  const signedData = nodes(nodes(contentInfo[1])[0]);
  const certificates = nodes(signedData[3]).map(
    (certificate) => new X509Certificate(der(certificate)),
  );
  assert(
    certificates.some((certificate) => certificate.fingerprint256 === expectedLeaf.fingerprint256),
  );
  assert(
    certificates.some(
      (certificate) => certificate.fingerprint256 === trustedTestRoot.fingerprint256,
    ),
  );
  assert(expectedLeaf.verify(trustedTestRoot.publicKey));
  assert(trustedTestRoot.verify(trustedTestRoot.publicKey));
  const signers = nodes(signedData[signedData.length - 1]);
  assert.equal(signers.length, 1);
  const signer = nodes(signers[0]);
  const sid = nodes(signer[1]);
  const leafTbs = nodes(nodes(forge.asn1.fromDer(expectedLeaf.raw.toString("binary"), true))[0]);
  const issuerIndex = leafTbs[0]?.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 3 : 2;
  assert(der(sid[0]!).equals(der(leafTbs[issuerIndex]!)), "CMS issuer differs from actual leaf");
  const serial = Buffer.from(bytes(sid[1]), "binary").toString("hex");
  assert.equal(BigInt(`0x${serial}`), BigInt(`0x${expectedLeaf.serialNumber}`));
  assert.equal(oid(nodes(signer[2])[0]), forge.pki.oids.sha256);
  const attributes = nodes(signer[3]);
  const attribute = (name: string) => {
    const found = attributes.filter((entry) => oid(nodes(entry)[0]) === name);
    assert.equal(found.length, 1);
    return nodes(nodes(found[0])[1])[0]!;
  };
  const signedContent = Buffer.concat([buffer.subarray(0, length), buffer.subarray(second)]);
  assert.equal(
    Buffer.from(bytes(attribute(forge.pki.oids.messageDigest!)), "binary").toString("hex"),
    createHash("sha256").update(signedContent).digest("hex"),
  );
  const signedAttributes = der(
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attributes),
  );
  assert(
    verify(
      "RSA-SHA256",
      signedAttributes,
      expectedLeaf.publicKey,
      Buffer.from(bytes(signer[5]), "binary"),
    ),
  );
  const time = attribute(forge.pki.oids.signingTime!);
  const signedAt =
    time.type === forge.asn1.Type.UTCTIME
      ? forge.asn1.utcTimeToDate(bytes(time))
      : forge.asn1.generalizedTimeToDate(bytes(time));
  assert(signedAt >= expectedLeaf.validFromDate && signedAt <= expectedLeaf.validToDate);
  return { signedAt, byteRange: [start, length, second, tail] };
}

/** 合法PKCS#12结构中的EC PKCS#8 keyBag；标准RSA驱动必须拒绝。 */
export function unsupportedEcP12(): P12Material {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const asn = forge.asn1;
  const seq = (value: Asn1[]) => asn.create(asn.Class.UNIVERSAL, asn.Type.SEQUENCE, true, value);
  const objectId = (value: string) =>
    asn.create(asn.Class.UNIVERSAL, asn.Type.OID, false, asn.oidToDer(value).getBytes());
  const explicit = (value: Asn1) => asn.create(asn.Class.CONTEXT_SPECIFIC, 0, true, [value]);
  const octets = (value: Asn1) =>
    asn.create(asn.Class.UNIVERSAL, asn.Type.OCTETSTRING, false, asn.toDer(value).getBytes());
  const data = (value: Asn1) => seq([objectId("1.2.840.113549.1.7.1"), explicit(octets(value))]);
  const safe = seq([
    seq([
      objectId("1.2.840.113549.1.12.10.1.1"),
      explicit(asn.fromDer(key.export({ format: "der", type: "pkcs8" }).toString("binary"))),
    ]),
  ]);
  const pfx = seq([
    asn.create(asn.Class.UNIVERSAL, asn.Type.INTEGER, false, "\x03"),
    data(seq([data(safe)])),
  ]);
  return { p12: der(pfx), passphrase: TEST_PASSPHRASE };
}
