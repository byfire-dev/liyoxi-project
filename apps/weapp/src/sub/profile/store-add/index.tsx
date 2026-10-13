import { useState } from "react";
import { View } from "@tarojs/components";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { Note } from "@/components/Note";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import {
  Frame,
  TextField,
  DictPicker,
  ActionError,
  useTenantAction,
  useTenantRead,
} from "../../member/members/view";
import { tenantRuntime } from "../../member/members/runtime";
import type { Body } from "../../member/members/api";
import { canCreateStore, storeCreateBody } from "./model";
import { useDraft } from "../private/draft";
type CreateForm = {
  name: string;
  detail: string;
  industry: string | null;
  category: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  options: NonNullable<Body<"m.store.create">["copyOptions"]>;
};
const empty: CreateForm = {
  name: "",
  detail: "",
  industry: null,
  category: null,
  province: null,
  city: null,
  district: null,
  options: [],
};
export default function AddStore() {
  const storeId = useContextStore((s) => s.currentStoreId);
  const read = useTenantRead((api) => api.stores());
  const action = useTenantAction("store_create");
  const [form, setForm] = useDraft<undefined, CreateForm>(undefined, () => empty, empty);
  const { name, detail, industry, category, province, city, district, options } = form;
  const change = <K extends keyof CreateForm>(key: K, value: CreateForm[K]) =>
    setForm((old) => ({ ...old, [key]: value }));
  const setName = (v: string) => change("name", v),
    setDetail = (v: string) => change("detail", v);
  const setIndustry = (v: string | null) => change("industry", v),
    setCategory = (v: string | null) => change("category", v);
  const setProvince = (v: string | null) => change("province", v),
    setCity = (v: string | null) => change("city", v),
    setDistrict = (v: string | null) => change("district", v);
  const setOptions = (next: (old: CreateForm["options"]) => CreateForm["options"]) =>
    setForm((old) => ({ ...old, options: next(old.options) }));
  const [created, setCreated] = useState<{ storeId: string; token: string | null } | null>(null);
  const token = useSessionStore((s) => s.accessToken);
  const completed = created !== null && created.token === token;
  const industryList = useTenantRead((api) => api.dict("industry"));
  const categoryList = useTenantRead(
    (api) => (industry ? api.dict("industry", industry) : Promise.resolve([])),
    industry ?? "",
  );
  const provinces = useTenantRead((api) => api.dict("region"));
  const cities = useTenantRead(
    (api) => (province ? api.dict("region", province) : Promise.resolve([])),
    province ?? "",
  );
  const districts = useTenantRead(
    (api) => (city ? api.dict("region", city) : Promise.resolve([])),
    city ?? "",
  );
  const source = useTenantRead(async (api, sourceId) => {
    const stores = await api.stores();
    if (
      stores.viewerRole !== "owner" ||
      !stores.items.some((s) => s.storeId === sourceId && s.lifecycle === "active")
    )
      return null;
    return { service: await api.service(), assets: await api.brandSummary() };
  });
  const allowed = canCreateStore(read.data);
  const sourceStore = read.data?.items.find(
    (s) => s.storeId === storeId && s.lifecycle === "active",
  );
  const save = () =>
    void action.run(
      { name, detail, industry, category, province, city, district, options, storeId },
      async (key, current, alive) => {
        if (completed) return;
        if (!allowed) throw new Error("当前不可新增门店，请核对门店额度");
        if (!province || !city || !district) throw new Error("请选择省、市、区县");
        const prefix = [
          provinces.data?.find((x) => x.code === province)?.name,
          cities.data?.find((x) => x.code === city)?.name,
          districts.data?.find((x) => x.code === district)?.name,
        ].join("");
        const body = storeCreateBody({
          name,
          detail,
          industry,
          category,
          addressPrefix: prefix,
          sourceId: sourceStore?.storeId ?? null,
          options,
        });
        const runtime = await tenantRuntime();
        if (!current()) return;
        const result = await runtime.api.createStore(body, key);
        if (current()) {
          setCreated({ storeId: result.storeId, token: useSessionStore.getState().accessToken });
          await runtime.selectResult(result.storeId, current, undefined, alive);
        }
        return result;
      },
    );
  return (
    <Frame loading={read.loading} error={read.error} retry={() => void read.load()}>
      <View className="tenant-stack">
        <ActionError error={action.error} />
        {read.data?.viewerRole !== "owner" ? (
          <Note>仅老板可新增门店</Note>
        ) : (
          <>
            {completed ? (
              <Card title="门店已创建">
                <Note>门店已成功创建；如切换或跳转失败，可继续进入这家门店完善档案</Note>
                <Button
                  loading={action.busy}
                  onClick={() =>
                    void action.run({ continue: created.storeId }, async (_key, current, alive) =>
                      (await tenantRuntime()).selectResult(
                        created.storeId,
                        current,
                        undefined,
                        alive,
                      ),
                    )
                  }
                >
                  继续完善该店档案
                </Button>
              </Card>
            ) : null}
            <Card title="门店额度">
              <View>
                {read.data.entity.storesUsed}/{read.data.entity.storeLimit} 家 ·{" "}
                {read.data.entity.subscription?.planName ?? "暂无生效套餐"}
              </View>
              {!allowed ? <Note>当前不能新增，请先处理额度或套餐</Note> : null}
            </Card>
            <Card title="门店资料">
              <View className="tenant-stack">
                <TextField
                  label="门店名称"
                  value={name}
                  onChange={setName}
                  max={30}
                  required
                  disabled={action.busy}
                />
                <DictPicker
                  label="行业"
                  value={industry}
                  items={(industryList.data ?? []).filter((x) => !x.parentCode)}
                  onSelect={(v) => {
                    setIndustry(v);
                    setCategory(null);
                  }}
                  disabled={action.busy}
                />
                <DictPicker
                  label="品类"
                  value={category}
                  items={(categoryList.data ?? []).filter((x) => x.parentCode === industry)}
                  onSelect={setCategory}
                  disabled={action.busy || !industry}
                />
                <DictPicker
                  label="省份"
                  value={province}
                  items={(provinces.data ?? []).filter((x) => !x.parentCode)}
                  onSelect={(v) => {
                    setProvince(v);
                    setCity(null);
                    setDistrict(null);
                  }}
                  disabled={action.busy}
                />
                <DictPicker
                  label="城市"
                  value={city}
                  items={(cities.data ?? []).filter((x) => x.parentCode === province)}
                  onSelect={(v) => {
                    setCity(v);
                    setDistrict(null);
                  }}
                  disabled={action.busy || !province}
                />
                <DictPicker
                  label="区县"
                  value={district}
                  items={(districts.data ?? []).filter(
                    (x) => x.parentCode === city && x.ext.functionalZone !== true,
                  )}
                  onSelect={setDistrict}
                  disabled={action.busy || !city}
                />
                <TextField
                  label="街道与门牌号"
                  value={detail}
                  onChange={setDetail}
                  max={160}
                  required
                  disabled={action.busy}
                />
                <Note>
                  请手动填写地址；建店后在档案中继续核对完整区划与资质，不使用未经开放的地图选点
                </Note>
                {[industryList, categoryList, provinces, cities, districts].map((r, i) =>
                  r.error ? (
                    <Note key={i} tone="warning">
                      {r.error.message}
                      <Button variant="outline" onClick={() => void r.load()}>
                        重试字典
                      </Button>
                    </Note>
                  ) : null,
                )}
              </View>
            </Card>
            {sourceStore ? (
              <Card title={`从当前门店复制：${sourceStore.name ?? "未命名门店"}`}>
                <Note>资质不复制；门头与店内环境请以本店实拍为准</Note>
                {(
                  [
                    ["basic", "基础信息"],
                    ["service", "服务与价格"],
                    ["media", "门店形象（需核对本店实拍）"],
                    ["brand_assets", "品牌故事素材"],
                  ] as const
                ).map(([key, label]) => (
                  <Checkbox
                    key={key}
                    checked={options.includes(key)}
                    disabled={action.busy}
                    onChange={(yes) =>
                      setOptions((old) => (yes ? [...old, key] : old.filter((v) => v !== key)))
                    }
                  >
                    {label}
                  </Checkbox>
                ))}
                {source.data ? (
                  <View className="tenant-muted">
                    主推服务 {source.data.service.serviceItems.length} 项 · 品牌故事素材{" "}
                    {source.data.assets.tabs.all} 条
                  </View>
                ) : null}
                {source.error ? (
                  <Note tone="warning">
                    复制来源读取失败：{source.error.message}
                    <Button variant="outline" onClick={() => void source.load()}>
                      重新读取
                    </Button>
                  </Note>
                ) : null}
              </Card>
            ) : null}
            <Button block disabled={!allowed || completed} loading={action.busy} onClick={save}>
              创建并完善档案
            </Button>
          </>
        )}
      </View>
    </Frame>
  );
}
