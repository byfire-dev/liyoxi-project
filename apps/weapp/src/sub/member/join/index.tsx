import { useEffect, useRef, useState } from "react";
import Taro, { useDidHide, useDidShow, useRouter } from "@tarojs/taro";
import { View } from "@tarojs/components";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { Empty } from "@/components/Empty";
import { TextButton } from "@/components/TextButton";
import { Note } from "@/components/Note";
import { ApiError } from "@/lib/request";
import { account } from "@/lib/account-runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { ActionError, Frame, TextField, useTenantAction, useTenantRead } from "../members/view";
import { tenantRuntime, tenantNavigate } from "../members/runtime";
import {
  joinLogin,
  joinedLoginScope,
  ownsJoinedLogin,
  previewLabel,
  validInvitationToken,
} from "./runtime";
export default function JoinPage() {
  const pageLife = useRef({ generation: 0, visible: true });
  useDidShow(() => {
    pageLife.current.visible = true;
  });
  useDidHide(() => {
    pageLife.current.visible = false;
    pageLife.current.generation++;
  });
  useEffect(() => {
    const life = pageLife.current;
    life.visible = true;
    return () => {
      life.visible = false;
      life.generation++;
    };
  }, []);
  const token = useRouter().params.token ?? "";
  const loggedIn = useSessionStore((s) => Boolean(s.accessToken));
  const [agreed, setAgreed] = useState(false),
    [displayName, setName] = useState("");
  const read = useTenantRead(async (api) => {
    if (!validInvitationToken(token)) return null;
    try {
      return await api.lookup(token);
    } catch (e) {
      if (e instanceof ApiError && e.error === "INVITATION_INVALID") return null;
      throw e;
    }
  }, token);
  const agreements = useTenantRead((api) => api.agreements());
  const version = JSON.stringify(
    agreements.data?.items.map((a) => a.currentVersion?.agreementVersionId),
  );
  const [checkedVersion, setCheckedVersion] = useState(version);
  if (checkedVersion !== version) {
    setCheckedVersion(version);
    setAgreed(false);
  }
  const login = useTenantAction("member_join_login"),
    accept = useTenantAction("invitation_accept");
  const preview = read.data;
  const join = (ownsLogin: () => boolean = () => true) =>
    void accept.run(
      { token, displayName, id: preview?.invitationId },
      async (key, current, alive) => {
        if (preview?.status !== "pending" || !useSessionStore.getState().accessToken)
          throw new Error("请先确认邀请状态并登录");
        const runtime = await tenantRuntime();
        if (!current() || !ownsLogin()) return;
        const result = await runtime.api.accept(
          preview.invitationId,
          { token, ...(displayName.trim() ? { displayName: displayName.trim() } : {}) },
          key,
        );
        if (current() && ownsLogin())
          await runtime.selectResult(
            result.storeId,
            () => current() && ownsLogin(),
            result.role === "owner"
              ? "sub/profile/profile/index"
              : "sub/profile/staff-profile/index",
            alive,
          );
        return result;
      },
    );
  const phoneJoin = (code?: string) =>
    void login.run(
      {
        phone: true,
        version: agreements.data?.items.map((a) => a.currentVersion?.agreementVersionId),
      },
      async (_key, current) => {
        const pageGeneration = pageLife.current.generation;
        const runtime = await tenantRuntime();
        try {
          const consents =
            agreements.data?.items.flatMap((a) =>
              a.currentVersion
                ? [
                    {
                      agreementKey: a.agreementKey,
                      agreementVersionId: a.currentVersion.agreementVersionId,
                    },
                  ]
                : [],
            ) ?? [];
          if (!current()) return;
          const result = await joinLogin(runtime.api, {
            phoneCode: code ?? "",
            agreed,
            loginCode: runtime.loginCode,
            consents,
            current,
            attribution: runtime.attribution(),
          });
          if (!current()) return;
          const expected = {
            token: result.token,
            ...joinedLoginScope(result.me, useContextStore.getState()),
            pageGeneration,
          };
          const ownsLogin = () =>
            ownsJoinedLogin(expected, {
              token: useSessionStore.getState().accessToken,
              storeId: useContextStore.getState().currentStoreId,
              contextRev: useContextStore.getState().contextRev,
              pageGeneration: pageLife.current.generation,
              visible: pageLife.current.visible,
            });
          useSessionStore.getState().setSession(result.token, result.me);
          await account.reloadMe();
          if (ownsLogin()) join(ownsLogin);
        } catch (e) {
          if (e instanceof ApiError && e.error === "AGREEMENT_VERSION_STALE" && current()) {
            setAgreed(false);
            await agreements.load();
          }
          throw e;
        }
      },
    );
  const busy = login.busy || accept.busy;
  return (
    <Frame loading={read.loading} error={read.error} retry={() => void read.load()}>
      <View className="tenant-stack">
        <ActionError error={login.error ?? accept.error} />
        {!preview ? (
          <Empty title="邀请不存在或链接无效" description="请向门店老板索取新的邀请" />
        ) : (
          <Card title={previewLabel(preview.status)}>
            <View>{preview.storeName ?? "门店"}</View>
            <View className="tenant-muted">
              {preview.city?.name} · {preview.category?.name}
            </View>
            <View>{preview.inviterName}邀请你以店员身份加入</View>
            <View>有效期至 {preview.expiresAt}</View>
            {preview.isPhoneRestricted ? <Note>本邀请仅限指定手机号接受</Note> : null}
            {preview.status === "pending" ? (
              <>
                <TextField
                  label="你的称呼（账号无称呼时必填）"
                  value={displayName}
                  onChange={setName}
                  max={20}
                  disabled={busy}
                />
                {!loggedIn ? (
                  <>
                    {agreements.error ? (
                      <Note tone="warning">
                        协议读取失败
                        <Button
                          variant="outline"
                          onClick={() => {
                            setAgreed(false);
                            void agreements.load();
                          }}
                        >
                          重新读取协议
                        </Button>
                      </Note>
                    ) : (
                      <>
                        {agreements.data?.items.map((a) =>
                          a.currentVersion ? (
                            <TextButton
                              key={a.agreementKey}
                              onClick={() =>
                                void Taro.navigateTo({
                                  url: `/pages/agreement/index?id=${encodeURIComponent(a.currentVersion!.agreementVersionId)}`,
                                })
                              }
                            >
                              {a.name} · {a.currentVersion.versionLabel}
                            </TextButton>
                          ) : null,
                        )}
                        <Checkbox checked={agreed} onChange={setAgreed} disabled={busy}>
                          我已阅读并同意以上协议
                        </Checkbox>
                      </>
                    )}
                    <Button
                      openType="getPhoneNumber"
                      disabled={!agreed || agreements.loading || !!agreements.error}
                      loading={busy}
                      onGetPhoneNumber={(e) => phoneJoin(e.detail.code)}
                    >
                      手机号快捷验证并加入
                    </Button>
                  </>
                ) : (
                  <Button loading={busy} onClick={() => join()}>
                    接受邀请并加入
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="outline"
                onClick={() => void tenantNavigate("sub/profile/stores/index")}
              >
                查看我的门店
              </Button>
            )}
          </Card>
        )}
      </View>
    </Frame>
  );
}
