import { useUploadBusy } from "@/lib/upload/taro";
import { formatMoney } from "@liyoxi/shared/format/money";
import { Image, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { FooterBar } from "@/components/FooterBar";
import { Sheet } from "@/components/Sheet";
import { Note } from "@/components/Note";
import { StepBar } from "@/components/StepBar";
import { TextButton } from "@/components/TextButton";
import type { Body, DictItems } from "../private/api";
import { Frame, Feedback, TextField, STEP_NAMES, useAction, useResource } from "../private/ui";
import { FileGrid, type MediaFile } from "../private/uploads";
import { parseFen, yuan } from "../private/model";
import { useDraft } from "../private/draft";
import { profileContext, profileRuntime } from "../private/runtime";
import { useMediaPreview } from "../private/use-media-preview";
type Item = NonNullable<Body<"m.storeProfile.service.update">["serviceItems"]>[number] & {
  image?: MediaFile | null;
};
export default function Service() {
  const uploading = useUploadBusy();
  const resource = useResource(async (api) => ({
    service: await api.service(),
    basic: await api.basic(),
    dicts: await api.dict("store_selling_point"),
  }));
  const action = useAction("profile_service", 3);
  const data = resource.data?.service;
  const [items, setItems, acceptItems] = useDraft(
    data,
    (value): Item[] =>
      value.serviceItems.map((item) => ({
        serviceItemId: item.serviceItemId,
        name: item.name,
        priceFen: item.priceFen,
        originalPriceFen: item.originalPriceFen,
        intro: item.intro,
        imageFileId: item.image?.fileId ?? null,
        image: item.image,
      })),
    [],
  );
  const [form, setForm, acceptForm] = useDraft(
    data,
    (value) => ({
      promo: value.promoText ?? "",
      groupBuy: value.groupBuyText ?? "",
      note: value.sellingNote ?? "",
      points: value.sellingPoints.map((p) => p.code),
    }),
    { promo: "", groupBuy: "", note: "", points: [] as string[] },
  );
  const previews = useMediaPreview(
    items.flatMap((item) =>
      item.image ? [{ fileId: item.image.fileId, src: item.image.coverUrl ?? item.image.url }] : [],
    ),
  );
  const [edit, setEdit] = useDraft(data, (): number | null => null, null);
  const emptyItem = { name: "", price: "", original: "", intro: "", image: [] as MediaFile[] };
  const [draft, setDraft] = useDraft(data, () => emptyItem, emptyItem);
  const [itemError, setItemError] = useDraft(data, (): string | null => null, null);
  const readonly = data?.viewerRole !== "owner";
  const save = async (draft: boolean) => {
    if (!data || data.viewerRole !== "owner") return;
    const context = profileContext();
    const body = {
      draft,
      lockVersion: data.lockVersion,
      serviceItems: items.map(({ image: _image, ...item }) => item),
      promoText: form.promo || null,
      groupBuyText: form.groupBuy || null,
      sellingNote: form.note || null,
      sellingPointCodes: form.points,
    };
    const value = await action.run(body, async (key) =>
      (await profileRuntime()).api.saveService(body, key),
    );
    if (value && action.isCurrent(context)) {
      acceptItems(value);
      acceptForm(value);
      resource.setData((old) => (old ? { ...old, service: value } : old));
      if (draft)
        void Taro.showToast({ title: "草稿已保存", icon: "success" }).catch(() => undefined);
      else await action.continueTo("cert", context);
    }
  };
  const candidates: DictItems = (resource.data?.dicts[0]?.items ?? []).filter((item) => {
    const categories = item.ext.categoryCodes;
    return (
      form.points.includes(item.code) ||
      !Array.isArray(categories) ||
      !categories.length ||
      categories.includes(resource.data?.basic.category?.code)
    );
  });
  const open = (index: number) => {
    const item = items[index];
    setEdit(index);
    setDraft({
      name: item?.name ?? "",
      price: item ? yuan(item.priceFen) : "",
      original: yuan(item?.originalPriceFen),
      intro: item?.intro ?? "",
      image: item?.image ? [item.image] : [],
    });
    setItemError(null);
  };
  return (
    <Frame
      loading={resource.loading}
      error={resource.error}
      retry={() => {
        void resource.load();
      }}
    >
      <StepBar steps={STEP_NAMES} current={2} />
      <Feedback
        action={action}
        refresh={() => {
          void resource.load();
        }}
      />
      <Card
        title="主推菜品 / 服务"
        extra={<View className="profile-subtitle">{items.length}/10</View>}
      >
        <View className="profile-subtitle">名称、价格、图片与简介将用于门店广告</View>
        {previews.pending ? <Note>图片加载中…</Note> : null}
        {previews.message ? (
          <Note tone="warning">
            {previews.message}
            <TextButton onClick={previews.retry}>重试加载图片</TextButton>
          </Note>
        ) : null}
        <View className="profile-spaced">
          {items.map((item, i) => (
            <View className="profile-row" key={item.serviceItemId ?? i}>
              {item.image && previews.sources[item.image.fileId] ? (
                <Image
                  className="profile-photo"
                  src={previews.sources[item.image.fileId]!}
                  mode="aspectFill"
                />
              ) : null}
              <View>
                <View>{item.name}</View>
                <View className="profile-money">{formatMoney(item.priceFen)}</View>
                <View className="profile-subtitle">{item.intro}</View>
              </View>
              {!readonly ? (
                <View>
                  <TextButton onClick={() => open(i)}>编辑</TextButton>
                  <TextButton onClick={() => setItems((old) => old.filter((_, n) => n !== i))}>
                    删除
                  </TextButton>
                </View>
              ) : null}
            </View>
          ))}
          {!readonly && items.length < 10 ? (
            <Button variant="outline" block onClick={() => open(items.length)}>
              添加主推服务
            </Button>
          ) : null}
        </View>
      </Card>
      <Card title="优惠与团购">
        <View className="profile-form">
          <TextField
            label="优惠活动"
            value={form.promo}
            max={100}
            disabled={readonly}
            onChange={(v) => setForm((old) => ({ ...old, promo: v }))}
          />
          <TextField
            label="团购信息"
            value={form.groupBuy}
            max={100}
            disabled={readonly}
            onChange={(v) => setForm((old) => ({ ...old, groupBuy: v }))}
          />
        </View>
      </Card>
      <Card title="核心卖点">
        <View className="profile-subtitle">至少选择1个标签，最多5个，候选按门店品类提供</View>
        {!candidates.some((point) => point.isSelectable || form.points.includes(point.code)) ? (
          <Note tone="warning">
            暂无可选的核心卖点标签，请联系平台配置后再继续。填写补充卖点不能代替标签选择，可先保存草稿。
          </Note>
        ) : null}
        <View className="profile-chips">
          {candidates.map((point) => (
            <Checkbox
              key={point.code}
              checked={form.points.includes(point.code)}
              disabled={
                readonly ||
                (!point.isSelectable && !form.points.includes(point.code)) ||
                (!form.points.includes(point.code) && form.points.length >= 5)
              }
              onChange={(checked) =>
                setForm((old) => ({
                  ...old,
                  points: checked
                    ? [...old.points, point.code]
                    : old.points.filter((code) => code !== point.code),
                }))
              }
            >
              {point.name}
            </Checkbox>
          ))}
        </View>
        <TextField
          label="补充卖点"
          hint="选填，不能代替上方的核心卖点标签"
          value={form.note}
          max={100}
          disabled={readonly}
          onChange={(v) => setForm((old) => ({ ...old, note: v }))}
        />
      </Card>
      {!readonly ? (
        <FooterBar>
          <Button
            variant="secondary"
            loading={action.busy}
            disabled={uploading}
            onClick={() => {
              void save(true);
            }}
          >
            保存草稿
          </Button>
          <Button
            loading={action.busy}
            disabled={uploading}
            onClick={() => {
              void save(false);
            }}
          >
            保存并下一步
          </Button>
        </FooterBar>
      ) : null}
      <Sheet
        visible={edit !== null && !readonly}
        title={edit !== null && edit < items.length ? "编辑主推服务" : "添加主推服务"}
        onClose={() => setEdit(null)}
        footer={
          <Button
            block
            onClick={() => {
              try {
                const price = parseFen(draft.price);
                if (!draft.name.trim() || !price) throw new Error("请填写名称与现价");
                const original = parseFen(draft.original);
                if (original !== null && original < price) throw new Error("原价不得低于现价");
                const next: Item = {
                  ...(edit !== null ? items[edit] : {}),
                  name: draft.name,
                  priceFen: price,
                  originalPriceFen: original,
                  intro: draft.intro || null,
                  imageFileId: draft.image[0]?.fileId ?? null,
                  image: draft.image[0] ?? null,
                };
                setItems((old) =>
                  edit !== null && edit < old.length
                    ? old.map((item, i) => (i === edit ? next : item))
                    : [...old, next],
                );
                setEdit(null);
              } catch (failure) {
                setItemError(failure instanceof Error ? failure.message : "请核对输入");
              }
            }}
          >
            保存本项
          </Button>
        }
      >
        <View className="profile-options">
          {itemError ? <View ariaRole="alert">{itemError}</View> : null}
          <FileGrid
            key={`service-image-${edit}`}
            files={draft.image}
            single
            max={1}
            onChange={(image) => setDraft((old) => ({ ...old, image }))}
          />
          <TextField
            label="服务名称"
            value={draft.name}
            max={30}
            required
            onChange={(name) => setDraft((old) => ({ ...old, name }))}
          />
          <TextField
            label="现价（元）"
            value={draft.price}
            max={12}
            numeric
            required
            onChange={(price) => setDraft((old) => ({ ...old, price }))}
          />
          <TextField
            label="原价（元）"
            value={draft.original}
            max={12}
            numeric
            onChange={(original) => setDraft((old) => ({ ...old, original }))}
          />
          <TextField
            label="服务简介"
            value={draft.intro}
            max={20}
            onChange={(intro) => setDraft((old) => ({ ...old, intro }))}
          />
        </View>
      </Sheet>
    </Frame>
  );
}
