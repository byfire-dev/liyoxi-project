import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button as NativeButton, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { Empty } from "@/components/Empty";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { List, ListRow } from "@/components/List";
import { LoadError } from "@/components/LoadError";
import { PageBody } from "@/components/PageBody";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { TextButton } from "@/components/TextButton";
import { gotoAccountLogin } from "@/lib/account-routing";
import { ensurePrivacyAuthorized, captureError } from "@/lib/runtime";
import { createPhoneAuthorization } from "@/pages/login/phone-authorization";
import type { Identity } from "./api";
import type { SettingsController } from "./model";
import { settingsScope, useSettingsResource } from "./runtime";
import "./index.scss";
import "./phone-button.scss";

function ChangePhone({ controller }: { controller: SettingsController }) {
  const [smsCode, setSmsCode] = useState("");
  const authorization = useMemo(
    () =>
      createPhoneAuthorization({
        supported: process.env.TARO_ENV === "weapp",
        scope: settingsScope,
        privacy: ensurePrivacyAuthorized,
        exhausted: () => captureError("handler", new Error("phone_component_quota_exhausted")),
      }),
    [],
  );
  useEffect(
    () => () => {
      authorization.dispose();
      controller.discardPhoneIntent();
    },
    [authorization, controller],
  );
  const phone = useSyncExternalStore(
    authorization.subscribe,
    authorization.snapshot,
    authorization.snapshot,
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((state.resendAt - now) / 1000));
  return (
    <View className="settings-page__form">
      <View className="settings-page__hint">
        先验证当前手机号 {state.me?.user.phoneMask}
        ，再授权新号码。成功后保留当前登录，其他登录会话失效。
      </View>
      <Button
        variant="secondary"
        block
        loading={state.busy === "phone_sms"}
        disabled={Boolean(state.busy) || seconds > 0}
        onClick={() => {
          void controller.sendSms();
        }}
      >
        {seconds ? `${seconds}秒后重新获取` : "向当前手机号发送验证码"}
      </Button>
      {state.sms ? (
        <View className="settings-page__hint">
          已发至 {state.sms.targetPhoneMask}，有效期至{" "}
          {appDateTimeFormat.dateTime(state.sms.expiresAt)}
        </View>
      ) : null}
      <Field label="当前手机号验证码">
        <Input
          value={smsCode}
          type="number"
          maxlength={8}
          disabled={Boolean(state.busy) || phone.busy}
          onChange={(value) => {
            controller.discardPhoneIntent();
            setSmsCode(value);
          }}
        />
      </Field>
      {phone.error ? (
        <View role="alert" className="settings-phone-error">
          {phone.error}
        </View>
      ) : null}
      {state.phoneRetryAvailable ? (
        <Button
          block
          loading={Boolean(state.busy)}
          onClick={() => {
            void controller.retryPhone().then((ok) => {
              if (ok) setSmsCode("");
            });
          }}
        >
          重试上次换绑
        </Button>
      ) : null}
      {phone.ready ? (
        <NativeButton
          className="settings-phone-button"
          openType="getPhoneNumber"
          disabled={Boolean(state.busy) || phone.busy || !/^\d{4,8}$/.test(smsCode)}
          onGetPhoneNumber={(event) => {
            void authorization.accept(event.detail, async (newPhoneCode) => {
              if (await controller.changePhone({ oldSmsCode: smsCode, newPhoneCode }))
                setSmsCode("");
            });
          }}
        >
          授权新号码并换绑
        </NativeButton>
      ) : (
        <Button
          block
          loading={phone.busy}
          disabled={Boolean(state.busy) || !/^\d{4,8}$/.test(smsCode)}
          onClick={() => {
            controller.discardPhoneIntent();
            void authorization.prepare(true);
          }}
        >
          授权新号码并换绑
        </Button>
      )}
      <View className="settings-page__hint">
        收不到原号码短信或验证暂不可用，请联系客服核实换绑。
      </View>
    </View>
  );
}

function SettingsContent({ resource }: { resource: ReturnType<typeof useSettingsResource> }) {
  const { state, controller, token } = resource;
  const [sheet, setSheet] = useState<"name" | "phone" | "identities" | "delete" | "logout" | null>(
    null,
  );
  const [name, setName] = useState(""),
    [remove, setRemove] = useState<Identity | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const busy = Boolean(state.busy);
  const close = () => {
    if (!busy) {
      controller.discardPhoneIntent();
      setSheet(null);
      setRemove(null);
      setConfirmed(false);
    }
  };
  const error = state.error ? (
    <View role="alert" className="settings-page__error">
      {state.error}
    </View>
  ) : null;
  const refresh = () => {
    void controller.refresh();
  };
  const identities = () => {
    setSheet("identities");
    void controller.identities();
  };
  return (
    <View
      className="settings-page"
      id={state.loaded && !state.loading ? "settings-ready" : undefined}
    >
      <PageBody>
        <View className="settings-page__title">账号设置</View>
        <View className="settings-page__hint">管理本人账号与安全，不影响门店角色权限。</View>
        {!token ? (
          <Card>
            <Empty
              title="登录后管理账号"
              description="可先查看下方隐私与服务协议"
              actionText="去登录"
              onAction={gotoAccountLogin}
            />
          </Card>
        ) : (
          <>
            {state.loading && !state.me ? (
              <Skeleton cards={2} rows={3} />
            ) : !state.me ? (
              <LoadError message={state.error ?? "暂未取得账号信息"} onRetry={refresh} />
            ) : (
              <>
                {state.me.notices.map((notice) => (
                  <Card key={notice.userNoticeId} title="账号安全提示">
                    <View>{notice.message}</View>
                    <TextButton
                      disabled={busy}
                      onClick={() => {
                        void controller.acknowledge(notice.userNoticeId);
                      }}
                    >
                      关闭这条提示
                    </TextButton>
                  </Card>
                ))}
                <List>
                  <ListRow
                    title="本人称呼"
                    value={state.me.user.displayName ?? "未设置"}
                    arrow={state.me.user.actions.includes("update")}
                    onClick={() => {
                      if (state.me?.user.actions.includes("update") && !busy) {
                        setName(state.me.user.displayName ?? "");
                        setSheet("name");
                      }
                    }}
                  />
                  <ListRow
                    title="手机号"
                    value={state.me.user.phoneMask}
                    description={
                      state.me.user.actions.includes("change-phone")
                        ? "验证原号码后授权新号码"
                        : "暂不支持自助换绑，请联系客服"
                    }
                    arrow={state.me.user.actions.includes("change-phone")}
                    onClick={() => {
                      if (state.me?.user.actions.includes("change-phone") && !busy)
                        setSheet("phone");
                    }}
                  />
                  <ListRow
                    title="已登录的微信"
                    description="查看登录设备，移除不再使用的身份"
                    onClick={identities}
                  />
                </List>
              </>
            )}
            {state.success ? (
              <View role="status" className="settings-page__hint">
                {state.success}
              </View>
            ) : null}
            {!sheet ? error : null}
          </>
        )}
        <View className="settings-page__section">隐私与服务</View>
        <List>
          {state.agreements.map((agreement) => (
            <ListRow
              key={agreement.agreementKey}
              title={agreement.name}
              onClick={() => {
                if (agreement.currentVersion)
                  void Taro.navigateTo({
                    url: `/pages/agreement/index?id=${encodeURIComponent(agreement.currentVersion.agreementVersionId)}`,
                  });
              }}
            />
          ))}
        </List>
        {!state.agreements.length ? (
          <TextButton onClick={refresh}>重新加载隐私与服务协议</TextButton>
        ) : null}
        <List>
          <ListRow
            title="通知设置"
            description="查看站内消息与实际订阅提醒状态"
            onClick={() => {
              if (!token) gotoAccountLogin();
              else void Taro.navigateTo({ url: "/sub/service/messages/index" });
            }}
          />
          <ListRow
            title="已授权的电脑"
            value="暂未开放"
            description="电脑授权管理开放后会显示在这里"
            arrow={false}
          />
        </List>
        {token ? (
          <List>
            <ListRow
              title="退出登录"
              onClick={() => {
                if (!busy) setSheet("logout");
              }}
            />
            {state.me?.user.actions.includes("deletion") ? (
              <ListRow
                title="注销账号"
                description="永久删除账号前，请先阅读后果说明"
                onClick={() => {
                  if (!busy) {
                    setConfirmed(false);
                    setSheet("delete");
                  }
                }}
              />
            ) : null}
          </List>
        ) : null}
      </PageBody>
      <Sheet
        visible={sheet !== null}
        title={
          sheet === "name"
            ? "修改本人称呼"
            : sheet === "phone"
              ? "换绑手机号"
              : sheet === "identities"
                ? "已登录的微信"
                : sheet === "delete"
                  ? "注销账号"
                  : "退出登录？"
        }
        onClose={close}
        closeOnOverlayClick={!busy}
        footer={
          sheet === "name" ? (
            <Button
              block
              loading={busy}
              onClick={() => {
                void controller.updateName(name).then((ok) => {
                  if (ok) setSheet(null);
                });
              }}
            >
              保存称呼
            </Button>
          ) : sheet === "delete" ? (
            <Button
              variant="danger"
              block
              disabled={!confirmed}
              loading={busy}
              onClick={() => {
                void controller.deletion();
              }}
            >
              确认注销账号
            </Button>
          ) : sheet === "logout" ? (
            <Button
              variant="danger"
              block
              loading={busy}
              onClick={() => {
                void controller.logout();
              }}
            >
              退出登录
            </Button>
          ) : undefined
        }
      >
        {error}
        {sheet === "name" ? (
          <Field label="本人称呼">
            <Input value={name} maxlength={40} disabled={busy} onChange={setName} />
          </Field>
        ) : null}
        {sheet === "phone" ? <ChangePhone controller={controller} /> : null}
        {sheet === "identities" ? (
          <>
            <View className="settings-page__hint">
              移除身份会使其全部登录会话失效，移除当前身份后需要重新登录。
            </View>
            {state.identityError ? (
              <LoadError
                message={state.identityError}
                onRetry={() => {
                  void controller.identities();
                }}
              />
            ) : null}
            {state.identitiesLoading && !state.identities.length ? (
              <Skeleton rows={3} />
            ) : (
              <List>
                {state.identities.map((item) => (
                  <ListRow
                    key={item.wechatIdentityId}
                    title={item.deviceSummary ?? "登录身份"}
                    value={
                      <View>
                        {item.isCurrent ? "当前登录" : ""}
                        {item.actions.includes("delete") ? (
                          <TextButton disabled={busy} onClick={() => setRemove(item)}>
                            移除
                          </TextButton>
                        ) : null}
                      </View>
                    }
                    description={
                      <View>
                        绑定于 {appDateTimeFormat.dateTime(item.boundAt)}
                        <View>最近登录 {appDateTimeFormat.dateTime(item.lastLoginAt)}</View>
                      </View>
                    }
                    arrow={false}
                  />
                ))}
              </List>
            )}
            {state.identitiesLoaded && !state.identities.length && !state.identityError ? (
              <Empty title="暂无登录身份" />
            ) : null}
            {state.hasMore ? (
              <Button
                variant="secondary"
                block
                loading={state.identitiesLoading}
                disabled={busy}
                onClick={() => {
                  void controller.moreIdentities();
                }}
              >
                继续查看登录身份
              </Button>
            ) : null}
          </>
        ) : null}
        {sheet === "delete" ? (
          <>
            <View className="settings-page__hint">
              注销成功后无法登录此账号，已绑定身份与会话将失效。历史交易依法留存；注销不会替你办理退款或关闭未办结事项。
            </View>
            {state.blockers.length ? (
              <Card title="暂不能注销">
                <List>
                  {state.blockers.map((item) => (
                    <ListRow
                      key={item.label}
                      title={item.label}
                      value={`${item.count}项`}
                      arrow={false}
                    />
                  ))}
                </List>
                <View className="settings-page__hint">
                  请联系客服办理未办结事项、老板更换或主体关闭后重试。
                </View>
              </Card>
            ) : null}
            <Checkbox checked={confirmed} disabled={busy} onChange={setConfirmed}>
              我已了解注销后果，确认注销本人账号
            </Checkbox>
          </>
        ) : null}
        {sheet === "logout" ? (
          <View className="settings-page__hint">退出后可继续浏览，管理门店需要重新登录。</View>
        ) : null}
      </Sheet>
      <Sheet
        visible={remove !== null}
        title={remove?.isCurrent ? "移除当前登录身份？" : "移除此登录身份？"}
        description="该身份的全部会话将失效；当前身份被移除后需重新登录。"
        onClose={() => {
          if (!busy) setRemove(null);
        }}
        closeOnOverlayClick={!busy}
        footer={
          <Button
            variant="danger"
            block
            loading={busy}
            onClick={() => {
              if (remove)
                void controller.remove(remove).then((ok) => {
                  if (ok) setRemove(null);
                });
            }}
          >
            确认移除
          </Button>
        }
      >
        {error}
      </Sheet>
    </View>
  );
}
export default function SettingsPage() {
  const resource = useSettingsResource();
  return <SettingsContent key={resource.scope} resource={resource} />;
}
