import { useState } from "react";
import { View } from "@tarojs/components";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { Empty } from "@/components/Empty";
import { List, ListRow } from "@/components/List";
import { LoadError } from "@/components/LoadError";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { TextButton } from "@/components/TextButton";
import type { SettingsController, SettingsState } from "./model";

export function PortalSessionsPanel({
  state,
  controller,
  onAuthorize,
}: {
  state: SettingsState;
  controller: SettingsController;
  onAuthorize: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const allowed = controller.canManageComputers();
  const selected = state.computers.find((row) => row.portalSessionId === selectedId);
  const busy = Boolean(state.busy);
  // Clear invalid local confirmation before rendering; an error recovery must not reopen it.
  if (
    selectedId !== null &&
    (!allowed ||
      state.computerError ||
      !selected ||
      state.computerResult?.portalSessionId === selectedId)
  ) {
    setSelectedId(null);
    setConfirmed(false);
  }
  const read = () => {
    void controller.computers();
  };
  const receipt = state.computerResult;
  return (
    <View className="settings-page__form">
      <View className="settings-page__hint">
        这里显示本人在当前主体下仍有效的电脑授权，各台电脑仅能访问授权时的门店。
      </View>
      {!allowed ? (
        <View>仅当前门店老板可管理电脑授权，请核对登录身份与所选门店。</View>
      ) : (
        <>
          <Button block disabled={busy} onClick={onAuthorize}>
            授权电脑
          </Button>
          <Button block variant="outline" disabled={busy} onClick={onAuthorize}>
            输入授权码
          </Button>
          {receipt ? (
            <View role="status" className="settings-page__hint">
              {receipt.browser} · {receipt.storeName ?? "未命名门店"}
              <View>
                {receipt.revokedAt
                  ? `已于 ${appDateTimeFormat.dateTime(receipt.revokedAt)} 撤销授权`
                  : `已读取当前状态，授权到期时间为 ${appDateTimeFormat.dateTime(receipt.expiresAt)}`}
              </View>
              {state.computerError ? <View>操作已返回，列表尚未更新，请重新读取列表。</View> : null}
            </View>
          ) : null}
          {state.computersLoading ? <View role="status">正在读取电脑授权…</View> : null}
          {state.computersLoading && !state.computersLoaded ? <Skeleton rows={3} /> : null}
          <List>
            {state.computers.map((item) => (
              <ListRow
                key={item.portalSessionId}
                title={item.browser}
                arrow={false}
                value={
                  <TextButton
                    disabled={
                      busy ||
                      state.computersLoading ||
                      Boolean(state.computerError) ||
                      receipt?.portalSessionId === item.portalSessionId
                    }
                    onClick={() => {
                      setSelectedId(item.portalSessionId);
                      setConfirmed(false);
                    }}
                  >
                    撤销授权
                  </TextButton>
                }
                description={
                  <View>
                    <View>授权门店：{item.storeName ?? "未命名门店"}</View>
                    <View>大致地区：{item.regionHint ?? "未取得地区"}</View>
                    <View>授权于 {appDateTimeFormat.dateTime(item.authorizedAt)}</View>
                    <View>到期于 {appDateTimeFormat.dateTime(item.expiresAt)}</View>
                  </View>
                }
              />
            ))}
          </List>
          {state.computersLoaded &&
          !state.computersLoading &&
          !state.computerError &&
          !state.computers.length ? (
            <Empty
              title="暂无有效电脑授权"
              description="可授权电脑访问当前门店，也可输入电脑上显示的授权码。"
            />
          ) : null}
          <Button
            block
            variant="secondary"
            loading={state.computersLoading}
            disabled={busy}
            onClick={read}
          >
            刷新电脑列表
          </Button>
        </>
      )}
      {state.computerError ? <LoadError message={state.computerError} onRetry={read} /> : null}
      <Sheet
        visible={Boolean(selected && allowed && !state.computerError)}
        title="撤销电脑授权？"
        description="撤销后，这台电脑下次请求将无法继续访问。其他电脑和小程序登录不受影响。"
        onClose={() => {
          if (!busy) {
            setSelectedId(null);
            setConfirmed(false);
            controller.discardComputerIntent();
          }
        }}
        closeOnOverlayClick={!busy}
        footer={
          <Button
            block
            variant="danger"
            loading={busy}
            disabled={!confirmed || !selected || state.computersLoading}
            onClick={() => {
              if (selected)
                void controller.revokeComputer(selected.portalSessionId).then((ok) => {
                  if (ok) {
                    setSelectedId(null);
                    setConfirmed(false);
                  }
                });
            }}
          >
            确认撤销授权
          </Button>
        }
      >
        {selected ? (
          <View className="settings-page__hint">
            <View>
              {selected.browser} · {selected.storeName ?? "未命名门店"}
            </View>
            <View>授权于 {appDateTimeFormat.dateTime(selected.authorizedAt)}</View>
          </View>
        ) : null}
        {state.error ? (
          <View role="alert" className="settings-page__error">
            {state.error}
          </View>
        ) : null}
        <Checkbox checked={confirmed} disabled={busy} onChange={setConfirmed}>
          我已核对这台电脑，确认撤销授权
        </Checkbox>
      </Sheet>
    </View>
  );
}
