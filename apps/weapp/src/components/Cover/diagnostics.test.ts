import { describe, expect, it } from "vitest";

import { coverImageFailure } from "./diagnostics";

describe("封面失败诊断", () => {
  it("只记录来源、资源摘要与收敛后的errMsg，签名更新不改变资源摘要", () => {
    const first = coverImageFailure(
      "https://user:password@media.example.test:9110/private/cover.jpg?X-Amz-Signature=secret-one#fragment-secret",
      "image:fail GET https://user:password@media.example.test/private/cover.jpg?X-Amz-Signature=secret-one net::ERR_CONNECTION_RESET Authorization: Bearer token-secret",
    );
    const refreshed = coverImageFailure(
      "https://media.example.test:9110/private/cover.jpg?X-Amz-Signature=secret-two",
      "image:fail",
    );
    expect(first).toEqual({
      origin: "https://media.example.test:9110",
      resourceHash: expect.stringMatching(/^[a-f\d]{8}$/),
      errMsg: "image:fail ERR_CONNECTION_RESET",
    });
    expect(first.resourceHash).toBe(refreshed.resourceHash);
    expect(first.resourceHash).not.toBe(
      coverImageFailure("https://media.example.test:9110/private/other.jpg", "").resourceHash,
    );
  });

  it.each([
    "image:fail X-Amz-Signature=standalone-secret&X-Amz-Credential=credential-secret",
    "image:fail https%3A%2F%2Fuser%3Apassword%40media.example.test%2Fcover.jpg%3Ftoken%3Dencoded-secret",
    "image:fail /cover.jpg?sig=relative-secret password=password-secret",
    "image:fail Bearer bearer-secret cookie=session-secret",
    { errMsg: "nested-secret" },
    undefined,
  ])("自由文本与非字符串不会泄露：%j", (message) => {
    expect(coverImageFailure("/local-cover.jpg?signature=local-secret", message)).toEqual({
      origin: "local",
      resourceHash: expect.stringMatching(/^[a-f\d]{8}$/),
      errMsg: "image:fail",
    });
  });

  it.each([
    ["image:fail url not in domain list ?signature=domain-secret", "domain not configured"],
    ["image:fail timeout ?signature=timeout-secret", "timeout"],
    ["image:fail TLS certificate failed ?token=tls-secret", "TLS"],
    ["image:fail network unavailable Authorization=network-secret", "network"],
    ["image:fail HTTP 403 ?X-Amz-Signature=status-secret", "HTTP 403"],
  ])("保留固定原因而丢弃其余内容：%s", (message, reason) => {
    expect(coverImageFailure("https://media.example.test/cover.jpg", message).errMsg).toBe(
      `image:fail ${reason}`,
    );
  });

  it("兼容IPv6与非法来源，不把凭据当作origin", () => {
    expect(coverImageFailure("http://user:pass@[::1]:9110/a.jpg?sig=secret", "").origin).toBe(
      "http://[::1]:9110",
    );
    expect(coverImageFailure("https://user:pass@bad%20host/a.jpg", "").origin).toBe("unknown");
  });
});
