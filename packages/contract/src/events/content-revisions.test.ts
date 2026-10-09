import { describe, expect, it } from "vitest";
import { eventPayloadSchema } from "./index.js";

const dramaId = "019ba146-0000-7000-8000-000000000001";
const revisionId = "019ba146-0000-7000-8000-000000000002";
const cases = [
  {
    name: "drama.tier_changed",
    good: { v: 1, dramaId, fromTier: null, toTier: "S" },
    bad: [
      { v: 1, dramaId, fromTier: "D", toTier: "S" },
      { v: 1, dramaId, fromTier: null },
    ],
  },
  {
    name: "drama.license_extended",
    good: {
      v: 1,
      dramaId,
      dramaCopyrightRevisionId: revisionId,
      prevEndDate: "2027-12-31",
      newEndDate: "2028-12-31",
    },
    bad: [
      {
        v: 1,
        dramaId,
        dramaCopyrightRevisionId: revisionId,
        prevEndDate: null,
        newEndDate: "2028-12-31",
      },
      {
        v: 1,
        dramaId,
        dramaCopyrightRevisionId: revisionId,
        prevEndDate: "2027-12-31",
        newEndDate: "2028-02-30",
      },
    ],
  },
  {
    name: "drama.license_scope_changed",
    good: {
      v: 1,
      dramaId,
      dramaCopyrightRevisionId: revisionId,
      platformsRemoved: ["douyin"],
      platformsAdded: ["wechat_channels"],
      isTerritoryChanged: true,
    },
    bad: [
      {
        v: 1,
        dramaId,
        dramaCopyrightRevisionId: revisionId,
        platformsRemoved: ["unknown"],
        platformsAdded: [],
        isTerritoryChanged: false,
      },
      {
        v: 1,
        dramaId,
        dramaCopyrightRevisionId: revisionId,
        platformsRemoved: [],
        platformsAdded: [],
        isTerritoryChanged: "false",
      },
    ],
  },
  {
    name: "drama.delisted",
    good: {
      v: 1,
      dramaId,
      reasonCode: "license_expired",
      fromState: "listed",
      toState: "delisted",
      transition: "drama.license_expire",
    },
    bad: [
      {
        v: 1,
        dramaId,
        reasonCode: "license_expired",
        fromState: "draft",
        toState: "delisted",
        transition: "drama.license_expire",
      },
      {
        v: 1,
        dramaId,
        reasonCode: "license_expired",
        fromState: "listed",
        toState: "delisted",
        transition: "unregistered",
      },
    ],
  },
  {
    name: "pricing.drama_price_changed",
    good: {
      v: 1,
      dramaId,
      dramaPriceRevisionId: null,
      cause: "tier_change",
      effectiveAt: "2026-01-06T00:00:00.000Z",
    },
    bad: [
      {
        v: 1,
        dramaId,
        dramaPriceRevisionId: revisionId,
        cause: "manual",
        effectiveAt: "2026-01-06T00:00:00.000Z",
      },
      {
        v: 1,
        dramaId,
        dramaPriceRevisionId: revisionId,
        cause: "revision",
        effectiveAt: "2026-01-06",
      },
    ],
  },
];

describe("W3-10既有事件的严格载荷", () => {
  for (const { name, good, bad } of cases) {
    it(`${name}：真实正式字段和v1可解析`, () => {
      expect(eventPayloadSchema(name)?.parse(good)).toEqual(good);
    });
    it(`${name}：拒绝错误字段、任意额外文本与错误版本`, () => {
      const schema = eventPayloadSchema(name)!;
      for (const payload of [...bad, { ...good, rawProof: "sensitive" }, { ...good, v: 2 }]) {
        expect(schema.safeParse(payload).success).toBe(false);
      }
    });
  }
});
