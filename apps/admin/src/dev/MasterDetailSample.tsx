import { getRouteApi } from "@tanstack/react-router";
import { Button, Space } from "antd";
import { useEffect, useState } from "react";

import { InfoList } from "../components/InfoList";
import { MasterDetailPage, type MasterDetailState } from "../components/MasterDetailPage";
import { PageHeader } from "../components/PageHeader";
import { QueryTablePage, type QueryState } from "../components/QueryTablePage";
import { readTableSearch, writeTableSearch } from "../lib/table-search";
import { DEV_FIXTURE_MARK } from "./mark";

const route = getRouteApi("/dev/master-detail");
const RECORDS = [
  { id: "a", name: "成都组", phoneMask: "138****0001", note: "样例记录 A" },
  { id: "b", name: "重庆组", phoneMask: "138****0002", note: "样例记录 B" },
  { id: "c", name: "昆明组", phoneMask: "138****0003", note: "样例记录 C" },
];
type RecordRow = (typeof RECORDS)[number];
function recordDetail(key: string): MasterDetailState {
  const row = RECORDS.find((item) => item.id === key);
  return row
    ? {
        key,
        status: "ready",
        content: (
          <InfoList
            items={[
              { label: "组名", value: row.name },
              { label: "手机号", value: row.phoneMask },
              { label: "说明", value: row.note },
            ]}
          />
        ),
      }
    : { key, status: "empty" };
}

export function MasterDetailSample() {
  const raw = route.useSearch();
  const navigate = route.useNavigate();
  const search = readTableSearch(raw);
  const selectedKey =
    typeof raw.id === "string" && RECORDS.some((row) => row.id === raw.id) ? raw.id : undefined;
  const [detail, setDetail] = useState<MasterDetailState>();
  const [mode, setMode] = useState("ready");
  const [innerClicks, setInnerClicks] = useState(0);
  useEffect(() => {
    if (!selectedKey) return;
    const timeout = setTimeout(() => setDetail(recordDetail(selectedKey)), 250);
    return () => clearTimeout(timeout);
  }, [selectedKey]);
  const filtered = RECORDS.filter((row) => !search.q || row.name.includes(search.q));
  const query: QueryState<RecordRow> =
    mode === "loading"
      ? { status: "loading" }
      : mode === "error"
        ? { status: "error", message: "样例列表暂时无法加载" }
        : {
            status: "success",
            items: mode === "empty" ? [] : filtered,
            total: mode === "empty" ? 0 : filtered.length,
          };
  const select = (id: string | undefined) =>
    void navigate({ search: { ...writeTableSearch(search), ...(id ? { id } : {}) } });
  return (
    <div data-fixture={DEV_FIXTURE_MARK} style={{ display: "contents" }}>
      <PageHeader
        title="主从页样例"
        subtitle="选中项与筛选写入 URL；详情只显示同一 key 的响应。数据为夹具。"
      />
      <Space wrap>
        {(["ready", "loading", "empty", "error"] as const).map((value, index) => (
          <Button key={value} onClick={() => setMode(value)}>
            {["正常列表", "列表加载", "列表为空", "列表错误"][index]}
          </Button>
        ))}
        <Button
          disabled={!selectedKey}
          onClick={() =>
            setDetail({ key: selectedKey!, status: "error", message: "样例详情暂时无法加载" })
          }
        >
          详情错误
        </Button>
        <Button disabled={selectedKey !== "b"} onClick={() => setDetail(recordDetail("a"))}>
          模拟 A 的过期响应
        </Button>
        <Button
          disabled={!selectedKey}
          onClick={() => selectedKey && setDetail(recordDetail(selectedKey))}
        >
          重新获取详情
        </Button>
        <Button onClick={() => select(undefined)}>取消选中</Button>
        <span>行内操作：{innerClicks}</span>
      </Space>
      <MasterDetailPage
        label="区域组主从样例"
        selectedKey={selectedKey}
        onSelect={select}
        detail={detail}
        detailTitle="选中组详情"
        onRetry={() => selectedKey && setDetail(recordDetail(selectedKey))}
        list={({ selectedKey: selected, onSelect }) => (
          <QueryTablePage<RecordRow>
            label="区域组列表"
            search={search}
            onSearchChange={(next) =>
              void navigate({
                search: { ...writeTableSearch(next), ...(selectedKey ? { id: selectedKey } : {}) },
              })
            }
            keywordPlaceholder="组名"
            columns={[
              { key: "name", title: "组名", render: (row) => row.name },
              {
                key: "phone",
                title: "手机号",
                mask: true,
                render: (row) => row.phoneMask,
                width: 150,
              },
              {
                key: "action",
                title: "操作",
                width: 88,
                render: () => (
                  <Button type="link" onClick={() => setInnerClicks((count) => count + 1)}>
                    查看说明
                  </Button>
                ),
              },
            ]}
            query={query}
            rowKey={(row) => row.id}
            selectedRowKey={selected}
            onRowClick={(row) => onSelect(row.id)}
            onRetry={() => setMode("ready")}
          />
        )}
      />
    </div>
  );
}
