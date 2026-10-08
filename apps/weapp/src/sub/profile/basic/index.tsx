import { useUploadBusy } from "@/lib/upload/taro";
import { useEffect, useState } from "react";
import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Note } from "@/components/Note";
import { TextButton } from "@/components/TextButton";
import { StepBar } from "@/components/StepBar";
import { FooterBar } from "@/components/FooterBar";
import type { Basic as BasicView, Body, DictItems } from "../private/api";
import {
  Frame,
  Feedback,
  DictPicker,
  TextField,
  STEP_NAMES,
  useAction,
  useResource,
} from "../private/ui";
import { FileGrid } from "../private/uploads";
import { profileContext, profileRuntime } from "../private/runtime";
import { parseFen, yuan } from "../private/model";
import { useDraft } from "../private/draft";
const basicForm = (data: BasicView) => ({
  brand: data.brandName ?? "",
  name: data.storeName ?? "",
  industry: data.industry?.code ?? null,
  category: data.category?.code ?? null,
  province: data.address.province?.code ?? null,
  city: data.address.city?.code ?? null,
  district: data.address.district?.code ?? null,
  detail: data.address.detail ?? "",
  tel: data.storeTel ?? "",
  spend: yuan(data.avgSpendFen),
  intro: data.brandIntro ?? "",
});
export default function Basic() {
  const uploading = useUploadBusy();
  const resource = useResource((api) => api.basic());
  const action = useAction("profile_basic", 1);
  const data = resource.data;
  const [form, setForm, acceptForm] = useDraft(data, basicForm, {
    brand: "",
    name: "",
    industry: null as string | null,
    category: null as string | null,
    province: null as string | null,
    city: null as string | null,
    district: null as string | null,
    detail: "",
    tel: "",
    spend: "",
    intro: "",
  });
  const [hours, setHours, acceptHours] = useDraft(
    data,
    (value) => (value.businessHours.length ? value.businessHours : [{ start: "", end: "" }]),
    [{ start: "", end: "" }],
  );
  const [logo, setLogo, acceptLogo] = useDraft(
    data,
    (value) => (value.logo ? [value.logo] : []),
    [],
  );
  const [dictError, setDictError] = useState<string | null>(null);
  const [dicts, setDicts] = useState<{ industry: DictItems; region: DictItems }>({
    industry: [],
    region: [],
  });
  useEffect(() => {
    let current = true;
    void profileRuntime()
      .then(async ({ api }) => {
        const groups = await api.dict("industry,region");
        if (current)
          setDicts({
            industry: groups.find((g) => g.typeKey === "industry")?.items ?? [],
            region: groups.find((g) => g.typeKey === "region")?.items ?? [],
          });
      })
      .catch(() => {
        if (current) setDictError("字典加载失败，请重新进入");
      });
    return () => {
      current = false;
    };
  }, []);
  const change = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((old) => ({ ...old, [key]: value }));
  const readonly = data?.viewerRole !== "owner";
  const reviewLocked = data?.reviewFieldsLocked || data?.reviewRequiredOnChange;
  const save = async (draft: boolean) => {
    if (!data || data.viewerRole !== "owner") return;
    const context = profileContext();
    const value = await action.run(
      { draft, form, logo, hours, lockVersion: data.lockVersion },
      async (key) => {
        const body: Body<"m.storeProfile.basic.update"> = {
          draft,
          lockVersion: data.lockVersion,
          brandName: form.brand || null,
          logoFileId: logo[0]?.fileId ?? null,
          brandIntro: form.intro || null,
          storeTel: form.tel || null,
          avgSpendFen: parseFen(form.spend),
          businessHours: hours.filter((slot) => slot.start || slot.end),
          ...(!reviewLocked
            ? {
                storeName: form.name || null,
                industryCode: form.industry,
                categoryCode: form.category,
                address: {
                  provinceCode: form.province,
                  cityCode: form.city,
                  districtCode: form.district,
                  zoneCode:
                    form.district === data.address.district?.code
                      ? (data.address.zone?.code ?? null)
                      : null,
                  detail: form.detail || null,
                  poiName: null,
                  latitude: null,
                  longitude: null,
                },
              }
            : {}),
        };
        const result = await (await profileRuntime()).api.saveBasic(body, key);
        return result;
      },
    );
    if (value && action.isCurrent(context)) {
      acceptForm(value);
      acceptHours(value);
      acceptLogo(value);
      resource.setData(value);
      if (draft)
        void Taro.showToast({ title: "草稿已保存", icon: "success" }).catch(() => undefined);
      else await action.continueTo("store", context);
    }
  };
  return (
    <Frame
      loading={resource.loading}
      error={resource.error}
      retry={() => {
        void resource.load();
      }}
    >
      <StepBar steps={STEP_NAMES} current={0} />
      <Feedback
        action={action}
        refresh={() => {
          void resource.load();
        }}
      />
      {data ? (
        <Card>
          <View className="profile-form">
            {dictError ? <Note tone="warning">{dictError}</Note> : null}
            {reviewLocked ? (
              <Note>审核中的名称、地址与行业不可修改；已通过后的变更入口将在后续开放</Note>
            ) : null}
            <TextField
              label="品牌名称"
              value={form.brand}
              max={30}
              required
              disabled={readonly}
              onChange={(v) => change("brand", v)}
            />
            <FileGrid files={logo} onChange={setLogo} single max={1} disabled={readonly} />
            <TextField
              label="门店名称"
              value={form.name}
              max={30}
              required
              disabled={readonly || reviewLocked}
              onChange={(v) => change("name", v)}
            />
            <DictPicker
              label="行业"
              value={form.industry}
              items={dicts.industry.filter((item) => !item.parentCode)}
              disabled={readonly || reviewLocked}
              onSelect={(v) => {
                change("industry", v);
                change("category", null);
              }}
            />
            <DictPicker
              label="品类"
              value={form.category}
              items={dicts.industry.filter((item) => item.parentCode === form.industry)}
              disabled={readonly || reviewLocked}
              onSelect={(v) => change("category", v)}
            />
            <DictPicker
              label="省份"
              value={form.province}
              items={dicts.region.filter((item) => !item.parentCode)}
              disabled={readonly || reviewLocked}
              onSelect={(v) =>
                setForm((old) => ({ ...old, province: v, city: null, district: null }))
              }
            />
            <DictPicker
              label="城市"
              value={form.city}
              items={dicts.region.filter((item) => item.parentCode === form.province)}
              disabled={readonly || reviewLocked}
              onSelect={(v) => setForm((old) => ({ ...old, city: v, district: null }))}
            />
            <DictPicker
              label="区县"
              value={form.district}
              items={dicts.region.filter(
                (item) => item.parentCode === form.city && item.ext.functionalZone !== true,
              )}
              disabled={readonly || reviewLocked}
              onSelect={(v) => change("district", v)}
            />
            <TextField
              label="详细地址"
              value={form.detail}
              max={200}
              required
              disabled={readonly || reviewLocked}
              onChange={(v) => change("detail", v)}
            />
            {hours.map((slot, index) => (
              <View key={index}>
                <TextField
                  label={`开始营业${index + 1}`}
                  value={slot.start}
                  max={5}
                  hint="24小时制，如 10:00"
                  required
                  disabled={readonly}
                  onChange={(start) =>
                    setHours((old) =>
                      old.map((hour, n) => (n === index ? { ...hour, start } : hour)),
                    )
                  }
                />
                <TextField
                  label={`结束营业${index + 1}`}
                  value={slot.end}
                  max={5}
                  hint="24小时制，如 22:00；跨午夜可填次日时间"
                  required
                  disabled={readonly}
                  onChange={(end) =>
                    setHours((old) => old.map((hour, n) => (n === index ? { ...hour, end } : hour)))
                  }
                />
                {!readonly && hours.length > 1 ? (
                  <TextButton onClick={() => setHours((old) => old.filter((_, n) => n !== index))}>
                    删除时段
                  </TextButton>
                ) : null}
              </View>
            ))}
            {!readonly && hours.length < 4 ? (
              <Button
                variant="outline"
                onClick={() => setHours((old) => [...old, { start: "", end: "" }])}
              >
                添加营业时段
              </Button>
            ) : null}
            <TextField
              label="门店电话"
              value={form.tel}
              max={20}
              required
              disabled={readonly}
              onChange={(v) => change("tel", v)}
            />
            <TextField
              label="人均消费（元）"
              value={form.spend}
              numeric
              max={12}
              required
              disabled={readonly}
              onChange={(v) => change("spend", v)}
            />
            <TextField
              label="品牌简介"
              value={form.intro}
              max={300}
              disabled={readonly}
              onChange={(v) => change("intro", v)}
            />
          </View>
        </Card>
      ) : null}
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
    </Frame>
  );
}
