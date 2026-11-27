/** Keep the owner prefix and file extension; different bytes/owners never share a key. */
export function contentAddressedKey(base: string, identity: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(identity) || !/^[a-f0-9]{64}$/.test(sha256))
    throw new TypeError("Invalid content identity");
  const slash = base.lastIndexOf("/");
  return `${base.slice(0, slash + 1)}ca-v1/${identity}/${sha256}/${base.slice(slash + 1)}`;
}
export function isContentAddressedKey(key: string, identity: string, sha256: string): boolean {
  return (
    /^[a-f0-9]{64}$/.test(identity) &&
    /^[a-f0-9]{64}$/.test(sha256) &&
    new RegExp(`(?:^|/)ca-v1/${identity}/${sha256}/[^/]+$`).test(key)
  );
}
