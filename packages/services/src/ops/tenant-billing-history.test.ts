import { describe, expect, it } from "vitest";

import { readBillingHistoryFacts } from "../billing/index.js";
import { AssemblyError, defineRegistration, implement } from "../kernel/index.js";
import { assembleForTest } from "../testing/index.js";
import { billingHistoryPort, registration as tenantRegistration } from "../tenant/index.js";

describe("tenant 必需计费历史事实端口", () => {
  it.each(["api", "worker"] as const)("%s 真实登记使用 billing 同事务读侧", (entry) => {
    const assembly = assembleForTest({ entry });
    expect(assembly.port(billingHistoryPort).read).toBe(readBillingHistoryFacts);
    expect(assembly.portImplementations.filter((item) => item.port === billingHistoryPort)).toEqual(
      [expect.objectContaining({ module: "billing", impl: { read: readBillingHistoryFacts } })],
    );
  });

  it.each(["api", "worker"] as const)("%s 缺真实实现拒绝装配，不默认无历史", (entry) => {
    expect(() => assembleForTest({ entry, withoutRealPorts: [billingHistoryPort] })).toThrow(
      AssemblyError,
    );
    expect(() => assembleForTest({ entry, withoutRealPorts: [billingHistoryPort] })).toThrow(
      /tenant\.billing_history：缺实现/,
    );
  });

  it("tenant 只声明必需口，既无自给实现也无 fallback", () => {
    expect(tenantRegistration.ports).toContain(billingHistoryPort);
    expect(
      tenantRegistration.portImplementations.some((item) => item.port === billingHistoryPort),
    ).toBe(false);
    expect(billingHistoryPort.fallback).toBeUndefined();
  });

  it("追加真实函数的第二个实现仍拒绝重复登记", () => {
    const duplicate = defineRegistration("lyxtest_history", {
      portImplementations: [implement(billingHistoryPort, { read: readBillingHistoryFacts })],
    });
    expect(() => assembleForTest({ entry: "api", extra: [duplicate, duplicate] })).toThrow(
      AssemblyError,
    );
    expect(() => assembleForTest({ entry: "api", extra: [duplicate, duplicate] })).toThrow(
      /tenant\.billing_history：重名/,
    );
  });
});
