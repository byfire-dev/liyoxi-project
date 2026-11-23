import { expect, it } from "vitest";
import {
  bankAccountActivationPolicy,
  bankAccountApprovalDelaySeconds,
  financeConfigActivationDelaySeconds,
} from "./activation-policy.js";

it.each([
  ["local", 0],
  ["test", 0],
  ["stg", 30],
  ["prod", 86_400],
] as const)(
  "%s snapshots its delay and cannot be approved in another environment",
  (env, seconds) => {
    const payload = { activationPolicy: bankAccountActivationPolicy(env) };
    expect(bankAccountApprovalDelaySeconds(env)).toBe(seconds);
    expect(financeConfigActivationDelaySeconds("bank_account", payload, env)).toBe(seconds);
    expect(() =>
      financeConfigActivationDelaySeconds(
        "bank_account",
        payload,
        env === "prod" ? "test" : "prod",
      ),
    ).toThrow();
  },
);

it("legacy bank versions retain 24h while unknown, malformed and non-bank policies are refused", () => {
  expect(financeConfigActivationDelaySeconds("bank_account", {})).toBe(86_400);
  expect(financeConfigActivationDelaySeconds("controls", {})).toBe(0);
  for (const policy of [null, 0, {}, "bank-delay-v9:prod:0s", "bank-delay-v1:prod:0s"])
    expect(() =>
      financeConfigActivationDelaySeconds("bank_account", { activationPolicy: policy }),
    ).toThrow();
  expect(() =>
    financeConfigActivationDelaySeconds("controls", {
      activationPolicy: bankAccountActivationPolicy("prod"),
    }),
  ).toThrow();
});
