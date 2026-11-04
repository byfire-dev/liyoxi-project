import { expect, it } from "vitest";
import { assertPortalDecision, portalCode, ticketExpired } from "./model";

it("accepts normalized short codes and preserves case-sensitive public ticket IDs", () => {
  expect(portalCode(" ab12-cd34 ")).toBe("AB12CD34");
  expect(portalCode("AbCdEfGhIjKlMnOpQrSt12")).toBe("AbCdEfGhIjKlMnOpQrSt12");
  expect(portalCode("1234IO56")).toBeNull();
});

it("extracts only one public ticket from the QR landing path", () => {
  const id = "AbCdEfGhIjKlMnOpQrSt12";
  expect(portalCode(`https://portal.example/a?t=${id}`)).toBe(id);
  expect(portalCode(`/a?t=${id}`)).toBe(id);
  expect(portalCode(`https://portal.example/a?t=${id}&t=${id}`)).toBeNull();
  expect(portalCode(`https://portal.example/other?t=${id}`)).toBeNull();
  expect(portalCode("/a?t=%ZZ")).toBeNull();
  expect(portalCode("javascript:alert(1)")).toBeNull();
});

it("blocks expired or malformed ticket timestamps", () => {
  const now = Date.parse("2026-11-03T10:00:00Z");
  expect(ticketExpired("2026-11-03T10:00:00Z", now)).toBe(true);
  expect(ticketExpired("invalid", now)).toBe(true);
  expect(ticketExpired("2026-11-03T10:00:01Z", now)).toBe(false);
});

it("决策前拒绝店员、换店、过期与不在候选内的配对数字", () => {
  const now = Date.parse("2026-11-04T00:00:00Z");
  const preview = {
    storeId: "store-a",
    expiresAt: "2026-11-04T00:02:00Z",
    pairChoices: ["17", "23", "36"],
  };
  expect(() =>
    assertPortalDecision(preview, { store: "store-a", role: "clerk" }, now, "17"),
  ).toThrow("仅老板");
  expect(() =>
    assertPortalDecision(preview, { store: "store-b", role: "owner" }, now, "17"),
  ).toThrow("门店已变化");
  expect(() =>
    assertPortalDecision(preview, { store: "store-a", role: "owner" }, now + 120000, "17"),
  ).toThrow("已过期");
  expect(() =>
    assertPortalDecision(preview, { store: "store-a", role: "owner" }, now, "99"),
  ).toThrow("两位数字");
  expect(() =>
    assertPortalDecision(preview, { store: "store-a", role: "owner" }, now, "17"),
  ).not.toThrow();
  expect(() =>
    assertPortalDecision(preview, { store: "store-a", role: "owner" }, now),
  ).not.toThrow();
});
