import { createPrivateKey, X509Certificate } from "node:crypto";

import forge from "node-forge";

export interface P12Material {
  readonly p12: Uint8Array;
  readonly passphrase: string;
}

/** 只核标准格式、密钥匹配、有效期和包内链；不证明根受到 CA/阅读器信任。 */
export function inspectP12(material: P12Material, signedAt: Date): X509Certificate {
  if (
    !(material.p12 instanceof Uint8Array) ||
    material.p12.byteLength === 0 ||
    material.p12.byteLength > 1_048_576 ||
    typeof material.passphrase !== "string" ||
    material.passphrase.length > 1024
  )
    throw new Error("签署材料格式不符合要求");
  const p12 = forge.pkcs12.pkcs12FromAsn1(
    forge.asn1.fromDer(Buffer.from(material.p12).toString("binary"), true),
    true,
    material.passphrase,
  );
  const keys =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag!
    ] ?? [];
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag!] ?? [];
  if (keys.length !== 1 || !keys[0]?.key || bags.length < 2 || bags.length > 10) {
    throw new Error("须有唯一 RSA 私钥及完整证书链");
  }
  const key = createPrivateKey(forge.pki.privateKeyToPem(keys[0].key));
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
    key.asymmetricKeyDetails?.publicExponent !== 65537n
  )
    throw new Error("仅支持 RSA2048 以上及标准指数");
  const certificates = bags.map((bag) => {
    if (!bag.cert) throw new Error("证书不完整");
    const cert = new X509Certificate(forge.pki.certificateToPem(bag.cert));
    if (signedAt < cert.validFromDate || signedAt > cert.validToDate) {
      throw new Error("证书不在有效期内");
    }
    return { cert, parsed: bag.cert };
  });
  // P12Signer从整个certBag选择最后一个匹钥证书，必须先保证全包唯一，不能只筛非CA。
  const matching = certificates.filter(({ cert }) => cert.checkPrivateKey(key));
  if (matching.length !== 1 || matching[0]!.cert.ca) {
    throw new Error("签署证书与私钥不匹配或不唯一");
  }
  const leaf = matching[0]!;
  const usage = leaf.parsed.getExtension("keyUsage") as { digitalSignature?: boolean } | null;
  if (usage && usage.digitalSignature !== true) throw new Error("证书不允许数字签名");
  let current = leaf;
  let nonSelfIssuedCAs = 0;
  const seen = new Set<string>();
  for (;;) {
    const { cert, parsed } = current;
    if (seen.has(cert.fingerprint256)) throw new Error("证书链成环");
    seen.add(cert.fingerprint256);
    const constraints = parsed.getExtension("basicConstraints") as {
      pathLenConstraint?: number;
    } | null;
    const limit = constraints?.pathLenConstraint;
    if (
      cert.ca &&
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 0 || nonSelfIssuedCAs > limit)
    ) {
      throw new Error("证书链超过CA路径长度约束");
    }
    const selfIssued = cert.subject === cert.issuer;
    // 自颁发的换钥CA仍须沿旧公钥找上级；仅自签的包内CA可作本次技术锚点。
    if (selfIssued && cert.verify(cert.publicKey)) {
      if (!cert.ca) throw new Error("根证书无效");
      return leaf.cert;
    }
    const issuers = certificates.filter(
      ({ cert: issuer }) =>
        issuer.fingerprint256 !== cert.fingerprint256 &&
        issuer.ca &&
        cert.checkIssued(issuer) &&
        cert.verify(issuer.publicKey),
    );
    if (issuers.length !== 1) throw new Error("证书链不完整或有歧义");
    // pathLen只计该CA以下的非自颁发CA；不计leaf，也不计当前CA本身。
    if (cert.ca && !selfIssued) nonSelfIssuedCAs += 1;
    current = issuers[0]!;
  }
}
