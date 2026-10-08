import { describe, expect, it } from "vitest";
import { refreshDraftMedia } from "./media-draft";

const media = (fileId: string, suffix = "old") => ({
  fileId,
  kind: "image",
  url: `https://media.example/${fileId}?${suffix}`,
  expiresAt: suffix === "old" ? "2026-10-08T00:30:00Z" : "2026-10-08T01:30:00Z",
  coverUrl: null as string | null,
  durationMs: null as number | null,
  displayWidth: 320,
  displayHeight: 240,
  moderationState: "pending",
});

describe("刷新媒体草稿的地址与状态", () => {
  it("基础信息形状的GET更新logo地址/封面/技术信息，保留草稿的非媒体字段", () => {
    const original = media("logo");
    const draft = [{ ...original, caption: "未保存的说明" }];
    const fresh = {
      ...media("logo", "fresh"),
      coverUrl: "https://media.example/cover?fresh",
      durationMs: 1000,
      displayWidth: 640,
      displayHeight: 480,
      moderationState: "pass",
    };
    const source = { brandName: "服务器品牌", logo: fresh };
    expect(refreshDraftMedia(draft, source)).toEqual([{ ...fresh, caption: "未保存的说明" }]);
    expect(draft).toEqual([{ ...original, caption: "未保存的说明" }]);
    expect(source.logo).toBe(fresh);
  });

  it("环境分组按fileId刷新，保留顺序和新上传；服务器的已删成员不复活", () => {
    const local = { ...media("unlinked"), url: "wxfile://tmp/new-photo", expiresAt: null };
    const draft = { door: [media("b"), media("a"), local], interior: [] };
    const freshA = media("a", "fresh");
    const freshB = media("b", "fresh");
    const source = {
      groups: {
        door: [freshA, freshB, media("removed", "fresh")].map((file) => ({ file })),
        interior: [{ file: media("removed-interior", "fresh") }],
      },
    };
    const next = refreshDraftMedia(draft, source);
    expect(next.door).toEqual([freshB, freshA, local]);
    expect(next.door[2]).toBe(local);
    expect(next.interior).toBe(draft.interior);
  });

  it("替换后的fileId和临时预览保留，不采用服务器上的旧图片", () => {
    const draft = [{ ...media("replacement"), url: "wxfile://tmp/replacement", expiresAt: null }];
    expect(refreshDraftMedia(draft, { logo: media("old-logo", "fresh") })).toBe(draft);
    expect(refreshDraftMedia([], { logo: media("deleted-logo", "fresh") })).toEqual([]);
  });

  it("服务列表与正在编辑的图片都刷新，不回退未保存名称、价格或说明", () => {
    const image = media("service-image");
    const source = {
      serviceItems: [{ name: "服务器名称", priceFen: 100, image: media(image.fileId, "fresh") }],
    };
    const list = [
      { name: "草稿名称", priceFen: 9900, intro: "草稿介绍", imageFileId: image.fileId, image },
    ];
    expect(refreshDraftMedia(list, source)).toEqual([
      { ...list[0], image: source.serviceItems[0]!.image },
    ]);
    const editing = { name: "正在编辑", price: "99.00", intro: "编辑中", image: [image] };
    expect(refreshDraftMedia(editing, source)).toEqual({
      ...editing,
      image: [source.serviceItems[0]!.image],
    });
  });

  it("服务器null地址和技术信息清除旧凭证，审核状态同步更新", () => {
    const draft = { image: { ...media("blocked"), coverUrl: "https://media.example/old-cover" } };
    const blocked = {
      ...draft.image,
      url: null,
      coverUrl: null,
      expiresAt: null,
      displayWidth: null,
      displayHeight: null,
      durationMs: null,
      moderationState: "block",
    };
    expect(refreshDraftMedia(draft, { nested: [blocked] })).toEqual({ image: blocked });
  });

  it("地址未变和无媒体的业务数据保持稳定引用，不复制或合并普通fileId记录", () => {
    const draft = { note: "本地", image: media("same"), doc: { fileId: "doc", title: "本地名称" } };
    expect(refreshDraftMedia(draft, { logo: { ...draft.image } })).toBe(draft);
    expect(refreshDraftMedia(draft, { fileId: "doc", title: "服务器名称", url: "普通记录" })).toBe(
      draft,
    );
    expect(refreshDraftMedia(draft, undefined)).toBe(draft);
    expect(refreshDraftMedia(draft, null)).toBe(draft);
    const form = { note: "本地未保存", price: "100", selected: ["SP01"] };
    expect(refreshDraftMedia(form, { note: "服务器", price: "20", selected: [] })).toBe(form);
  });

  it("一次刷新只复制变化分支；再次收到相同元数据返回原草稿引用", () => {
    const untouched = { name: "本地名称", selected: ["SP01"] };
    const draft = { groups: { door: [media("a")] }, untouched };
    const source = { groups: { door: [{ file: media("a", "fresh") }] } };
    const next = refreshDraftMedia(draft, source);
    expect(next).not.toBe(draft);
    expect(next.groups).not.toBe(draft.groups);
    expect(next.groups.door).not.toBe(draft.groups.door);
    expect(next.untouched).toBe(untouched);
    expect(refreshDraftMedia(next, structuredClone(source))).toBe(next);
  });
});
