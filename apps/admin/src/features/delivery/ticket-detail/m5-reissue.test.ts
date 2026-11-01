import { expect, it } from "vitest";
import { batchFixture, batchId, batchItem } from "./batch-test.fixture";
import { episodeRegistrationBody } from "./batch-model";
it("原整部登记body保持；补发显式携当前reissueId且仅消费申请内实际集号", () => {
  const batch = batchFixture({
    state: "ready",
    scope: "partial",
    items: [{ ...batchItem(), state: "checked" }],
    coverage: {
      missingEpisodeNos: [2],
      duplicateEpisodeNos: [],
      unmatchedItemIds: [],
      needsSequenceConfirm: false,
    },
  });
  expect(episodeRegistrationBody(batch)).toEqual({ uploadBatchId: batch.uploadBatchId });
  const reissue = { reissueId: batchId(9), episodeNos: [1] };
  expect(episodeRegistrationBody(batch, reissue)).toEqual({
    uploadBatchId: batch.uploadBatchId,
    reissueId: reissue.reissueId,
  });
  expect(() =>
    episodeRegistrationBody({ ...batch, items: [{ ...batchItem(2), state: "checked" }] }, reissue),
  ).toThrow("申请范围外");
  expect(() => episodeRegistrationBody({ ...batch, state: "verifying" }, reissue)).toThrow(
    "尚不能登记",
  );
});

import type { Grid, Ticket } from "./api";
import { reissueQualityOutputs } from "./model";
it("本次补发质检只选真实replacement，排除已发布原件与另一次补发；normal保持旧latest选择", () => {
  const original = { episodeOutputId: batchId(20), deliveryReissueId: null },
    current = { episodeOutputId: batchId(21), deliveryReissueId: batchId(9) },
    other = { episodeOutputId: batchId(22), deliveryReissueId: batchId(8) };
  const grid = {
    episodes: [
      { episodeNo: 1, current: original, latest: current, replacement: current },
      { episodeNo: 2, current: original, latest: other, replacement: other },
    ],
  } as Grid;
  const ticket = { openReissue: { reissueId: batchId(9) } } as Ticket;
  expect(reissueQualityOutputs(ticket, grid).map((row) => row.episodeOutputId)).toEqual([
    current.episodeOutputId,
  ]);
  expect(
    reissueQualityOutputs({ openReissue: null }, grid).map((row) => row.episodeOutputId),
  ).toEqual([current.episodeOutputId, other.episodeOutputId]);
});
