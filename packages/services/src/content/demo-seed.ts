import { calendarDate, daysInMonth, formatLocalDate, parseLocalDate } from "@liyoxi/shared/time";
import { createIdentityContext } from "../kernel/index.js";
import type { Clock, TxRunner, SeedTableResult, AppEnv } from "../kernel/index.js";
import { insertDictItemsMissing } from "../config/index.js";
import type { DictItemSeed } from "../config/index.js";
import type { Media } from "../media/index.js";
import type { Content } from "./service.js";
import { demoImage } from "./demo-image.js";
export const DEMO_DRAMAS = [
  {
    title: "巷口那家店",
    tier: "S",
    dramaClass: "class_1",
    episodes: 60,
    genres: ["G01", "G02"],
    industry: "C01",
    platforms: ["douyin", "wechat_channels"],
  },
  {
    title: "重逢在花店",
    tier: "A",
    dramaClass: "class_2",
    episodes: 40,
    genres: ["G03", "G04"],
    industry: "C04",
    platforms: ["douyin", "wechat_channels"],
  },
  {
    title: "修车师傅的秘密",
    tier: "B",
    dramaClass: "class_3",
    episodes: 20,
    genres: ["G05", "G06"],
    industry: "C07",
    platforms: ["douyin"],
  },
] as const;
const item = (
  dictTypeKey: string,
  code: string,
  name: string,
  position: number,
  parentCode: string | null = null,
): DictItemSeed => ({
  dictTypeKey,
  code,
  name,
  position,
  parentCode,
  description: null,
  ext: dictTypeKey === "industry" ? { open: true, special: false, requiredCerts: [] } : {},
});
export const DEMO_DICT_ITEMS: readonly DictItemSeed[] = [
  ...["都市生活", "家庭温情", "浪漫爱情", "轻松喜剧", "职场成长", "悬疑故事"].map((name, i) =>
    item("genre", `G0${i + 1}`, name, i),
  ),
  ...["人物鲜明", "情节紧凑", "生活共鸣", "轻松有趣"].map((name, i) => ({
    ...item("selling_tag", `T0${i + 1}`, name, i),
    description: `${name}，适合门店内容展示`,
  })),
  item("industry", "C01", "餐饮", 0),
  item("industry", "C02", "餐馆", 0, "C01"),
  item("industry", "C03", "饮品", 1, "C01"),
  item("industry", "C04", "零售", 1),
  item("industry", "C05", "花店", 0, "C04"),
  item("industry", "C06", "便利店", 1, "C04"),
  item("industry", "C07", "生活服务", 2),
  item("industry", "C08", "汽车维修", 0, "C07"),
  item("industry", "C09", "洗衣服务", 1, "C07"),
  ...["门店特色", "服务体验", "招牌产品", "优惠活动", "品牌故事"].map((name, i) =>
    item("custom_focus", `CF0${i + 1}`, name, i),
  ),
];
export interface ContentDemoDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly content: Content;
  readonly media: Pick<Media, "putSystemFile">;
  readonly appEnv: AppEnv;
}
export async function seedDemoContent(
  deps: ContentDemoDeps,
  staffId: string,
): Promise<readonly SeedTableResult[]> {
  if (deps.appEnv === "prod") throw new Error("prod 拒绝演示短剧播种");
  const now = deps.clock.now(),
    today = calendarDate(now),
    date = parseLocalDate(today),
    end = formatLocalDate(
      date.year + 2,
      date.month,
      Math.min(date.day, daysInMonth(date.year + 2, date.month)),
    ),
    ctx = createIdentityContext({ actor: { type: "staff", id: staffId, client: "cli" } });
  const dictionaries = await deps.tx.run((tx) => insertDictItemsMissing(tx, DEMO_DICT_ITEMS, now));
  const [scan, proof] = await Promise.all([
    deps.media.putSystemFile({
      category: "drama_license_doc",
      fileName: "demo-permit.png",
      body: demoImage([70, 110, 150]),
      objectKey: "drama_license_doc/demo/content-permit.png",
      entityId: null,
      storeId: null,
    }),
    deps.media.putSystemFile({
      category: "drama_license_doc",
      fileName: "demo-proof.png",
      body: demoImage([90, 130, 170]),
      objectKey: "drama_license_doc/demo/content-proof.png",
      entityId: null,
      storeId: null,
    }),
  ]);
  let inserted = 0,
    existing = 0;
  for (const [index, seed] of DEMO_DRAMAS.entries()) {
    let drama = await deps.tx.run((tx) =>
      tx.drama.findFirst({ where: { title: seed.title }, orderBy: { id: "asc" } }),
    );
    if (drama?.status === "listed") {
      existing++;
      continue;
    }
    if (!drama) {
      drama = await deps.tx.run((tx) => deps.content.createDraft(tx, ctx, { title: seed.title }));
      inserted++;
    } else existing++;
    const id = drama.id,
      poster = await deps.media.putSystemFile({
        category: "poster",
        fileName: `demo-poster-${index + 1}.png`,
        body: demoImage([100 + index * 30, 130 + index * 25, 160 + index * 20]),
        objectKey: `poster/demo/content-${index + 1}.png`,
        entityId: null,
        storeId: null,
      });
    drama = await deps.tx.run((tx) =>
      deps.content.saveBasic(tx, ctx, id, {
        lockVersion: drama!.lockVersion,
        posterFileId: poster.fileId,
        totalEpisodes: seed.episodes,
        genreCodes: [...seed.genres],
        sellingTagCodes: [`T0${index + 1}`],
        synopsis: `${seed.title}的原创门店故事。人物在日常生活中相遇，一同解决问题，传递温暖与信任。`,
        dramaClass: seed.dramaClass,
        episodeDurationSec: 90,
        producerName: "狸有戏演示内容",
        castNames: "演示演员",
      }),
    );
    drama = await deps.tx.run((tx) =>
      deps.content.saveCommercial(tx, ctx, id, {
        lockVersion: drama!.lockVersion,
        heatTier: seed.tier,
        industryCodes: [seed.industry],
        allowedPlacements: ["opening", "ending"],
        targetAudience: "本地生活消费者",
      }),
    );
    const hasPermit = await deps.tx.run((tx) =>
      tx.dramaPermit.count({ where: { dramaId: id, status: "active" } }),
    );
    if (!hasPermit) {
      await deps.tx.run((tx) =>
        deps.content.createPermit(tx, ctx, id, {
          platform: "all",
          permitKind: seed.dramaClass === "class_3" ? "program_no" : "license_no",
          permitNo: `DEMO-CONTENT-${index + 1}`,
          scanFileIds: [scan.fileId],
        }),
      );
    }
    const copyright = await deps.tx.run((tx) =>
      tx.dramaCopyright.findUniqueOrThrow({ where: { dramaId: id } }),
    );
    await deps.tx.run((tx) =>
      deps.content.saveCopyrightDraft(tx, ctx, id, {
        lockVersion: copyright.lockVersion,
        source: "own",
        platforms: [...seed.platforms],
        territory: "中国大陆",
        hasNetworkRight: true,
        canSublicense: true,
        canEditEmbed: true,
        canAdapt: true,
        licenseStartDate: today,
        licenseEndDate: end,
        proofFileIds: [proof.fileId],
      }),
    );
    await deps.tx.run((tx) => deps.content.list(tx, ctx, id));
  }
  return [dictionaries, { table: "drama", inserted, existing }];
}
