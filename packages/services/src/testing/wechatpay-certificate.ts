// 仅测试：运行时生成RSA与自签X509，不加载真实密钥、Provider或业务装配。
import { createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

interface TestIdentity {
  serial: string;
  privateKey: KeyObject;
  publicKeyPem: string;
  privateKeyPem: string;
}

/** 现场生成一对 RSA-2048 密钥 */
function generateIdentity(serial: string): TestIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    serial,
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** DER 的一个节点：标签、长度、内容 */
function der(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? [body.length]
      : body.length < 0x100
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

/**
 * 现场生成一张自签名的测试证书（X.509 v1，RSA-SHA256），供商户FILE配置边界使用，序列号与自身密钥对一致。
 * Node 没有签发证书的接口，这里手写最小的 DER。只给用例用。
 */
export function merchantCertificateForTest(): TestIdentity & { certificatePem: string } {
  const serialBytes = Buffer.concat([Buffer.from([0x4d]), randomBytes(19)]);
  const identity = generateIdentity(serialBytes.toString("hex").toUpperCase());
  const algorithm = der(0x30, Buffer.from("06092a864886f70d01010b0500", "hex"));
  const commonName = der(
    0x30,
    Buffer.from("0603550403", "hex"),
    der(0x0c, Buffer.from("lyx-test")),
  );
  const name = der(0x30, der(0x31, commonName));
  const validity = der(
    0x30,
    der(0x17, Buffer.from("260101000000Z")),
    der(0x17, Buffer.from("460101000000Z")),
  );
  const spki = createPublicKey(identity.publicKeyPem).export({ type: "spki", format: "der" });
  const tbs = der(0x30, der(0x02, serialBytes), algorithm, name, validity, name, spki);
  const signature = sign("RSA-SHA256", tbs, identity.privateKey);
  const certificate = der(0x30, tbs, algorithm, der(0x03, Buffer.from([0]), signature));
  const lines = certificate.toString("base64").match(/.{1,64}/g) ?? [];
  const certificatePem = `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { ...identity, certificatePem };
}
