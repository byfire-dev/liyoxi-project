import { useUploadBusy } from "@/lib/upload/taro";
import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useDidHide } from "@tarojs/taro";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { FooterBar } from "@/components/FooterBar";
import { Note } from "@/components/Note";
import { StepBar } from "@/components/StepBar";
import { withProfileSubscribe } from "../private/subscription";
import { Certificate } from "../private/certificates";
import { Frame, Feedback, TextField, STEP_NAMES, useAction, useResource } from "../private/ui";
import { useDraft } from "../private/draft";
import { profileContext, profileRuntime } from "../private/runtime";
import { errorInfo, qualificationEditable, qualificationKind } from "../private/model";
export default function Cert() {
  const uploading = useUploadBusy();
  const resource = useResource(async (api) => ({
    qualification: await api.qualification(),
    dicts: await api.dict("permit_type"),
  }));
  const action = useAction("qualification_save", 4);
  const submit = useAction("qualification_submit");
  const sms = useAction("qualification_contact_sms");
  const pendingAuthorization = useRef<{ context: string; key: string } | null>(null);
  const pendingDeclaration = useRef<string | null>(null);
  const [authorizingContext, setAuthorizingContext] = useState<string | null>(null);
  const data = resource.data?.qualification;
  const owner = data?.viewerRole === "owner" ? data : null;
  const round = owner?.openRound;
  const editable = qualificationEditable(owner);
  const authorizing = submit.busy || authorizingContext === profileContext();
  const [contact, setContact, acceptContact] = useDraft(
    owner?.contact,
    (value) => ({
      name: value.name ?? "",
      phoneSource: "login" as "login" | "input",
      phone: "",
    }),
    { name: "", phoneSource: "login" as "login" | "input", phone: "" },
  );
  const { name, phoneSource, phone } = contact;
  const [smsCode, setSmsCode] = useDraft(owner?.contact, () => "", "");
  const [smsReceipt, setSmsReceipt] = useState<{
    context: string;
    phone: string;
    resendAt: number;
    message: string;
  } | null>(null);
  const currentSms =
    smsReceipt?.context === profileContext() && smsReceipt.phone === phone ? smsReceipt : null;
  useEffect(() => {
    if (!smsReceipt?.resendAt) return;
    const timer = setTimeout(
      () => setSmsReceipt((value) => (value === smsReceipt ? { ...value, resendAt: 0 } : value)),
      Math.max(0, smsReceipt.resendAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [smsReceipt]);
  const setName = (name: string) => setContact((old) => ({ ...old, name }));
  const setPhoneSource = (phoneSource: "login" | "input") =>
    setContact((old) => ({ ...old, phoneSource }));
  const setPhone = (phone: string) => {
    setContact((old) => ({ ...old, phone }));
    setSmsCode("");
  };
  const [agreed, setAgreed] = useState(false);
  useDidHide(() => {
    setAgreed(false);
    setAuthorizingContext(null);
    pendingAuthorization.current = null;
  });
  const declarationKey = `${profileContext()}|${owner?.declaration.currentVersion ?? ""}|${round?.qualificationSubmissionId ?? ""}`;
  const [confirmedKey, setConfirmedKey] = useState(declarationKey);
  if (confirmedKey !== declarationKey) {
    setConfirmedKey(declarationKey);
    setAgreed(false);
  }
  const load = async () => {
    await resource.load();
  };
  const sameDeclaration = (context: string, key: string) => {
    const latest = resource.currentData()?.qualification;
    return (
      action.isCurrent(context) &&
      latest?.viewerRole === "owner" &&
      latest.openRound?.phase !== "in_review" &&
      `${context}|${latest.declaration.currentVersion}|${latest.openRound?.qualificationSubmissionId ?? ""}` ===
        key
    );
  };
  const saveDeclaration = (checked: boolean) => {
    if (!owner) return;
    const context = profileContext();
    if (
      pendingDeclaration.current === context ||
      pendingAuthorization.current?.context === context ||
      !action.isCurrent(context)
    )
      return;
    pendingDeclaration.current = context;
    const key = declarationKey;
    // 已保存的草稿不替代本页用户确认；写入失败或尚未完成时不能提交。
    setAgreed(false);
    const body = {
      lockVersion: round?.lockVersion ?? null,
      declarationConfirmed: checked,
      ...(checked ? { declarationVersion: owner.declaration.currentVersion } : {}),
    };
    void action
      .run(body, (key) => profileRuntime().then(({ api }) => api.saveQualification(body, key)))
      .then((value) => {
        if (!value || !sameDeclaration(context, key)) return;
        if (
          round &&
          value.openRound?.qualificationSubmissionId !== round.qualificationSubmissionId
        ) {
          action.setError(errorInfo(new Error("信息确认状态已变化，请刷新后重新确认")));
          return;
        }
        const latest = resource.currentData()?.qualification;
        if (
          latest?.viewerRole === "owner" &&
          latest.openRound &&
          value.openRound &&
          value.openRound.lockVersion < latest.openRound.lockVersion
        )
          return;
        resource.setData((old) => (old ? { ...old, qualification: value } : old));
        const saved =
          value.openRound != null &&
          (checked
            ? value.openRound.declarationConfirmedAt != null &&
              value.openRound.declarationVersion === owner.declaration.currentVersion &&
              value.declaration.currentVersion === owner.declaration.currentVersion
            : value.openRound.declarationConfirmedAt === null &&
              value.openRound.declarationVersion === null);
        if (!saved) {
          action.setError(errorInfo(new Error("信息确认未保存成功，请重新勾选")));
          return;
        }
        setConfirmedKey(
          `${context}|${value.declaration.currentVersion}|${value.openRound?.qualificationSubmissionId ?? ""}`,
        );
        setAgreed(checked && value.declaration.currentVersion === owner.declaration.currentVersion);
      })
      .finally(() => {
        if (pendingDeclaration.current === context) pendingDeclaration.current = null;
      });
  };
  return (
    <Frame
      loading={resource.loading}
      error={resource.error}
      retry={() => {
        void load();
      }}
    >
      <StepBar steps={STEP_NAMES} current={3} />
      <Feedback
        action={action}
        refresh={() => {
          void load();
        }}
      />
      <Feedback
        action={submit}
        refresh={() => {
          void load();
        }}
      />
      <Feedback action={sms} />
      {owner ? (
        <>
          {!editable ? (
            <Note>当前证照与声明只读，联系人仍可保存。审核进度与结果请到审核进度页查看</Note>
          ) : null}
          {owner.storeQualificationStatus === "verified" &&
          !owner.openRound &&
          !owner.isFinalRejected ? (
            <Button
              variant="outline"
              loading={action.busy}
              onClick={() => {
                const context = profileContext();
                void action
                  .run({ beginChange: true }, async (key) => {
                    const yes = await Taro.showModal({
                      title: "变更资质",
                      content: "变更内容需要重新审核；审核通过前继续使用当前有效资质",
                    });
                    if (!yes.confirm || !action.isCurrent(context)) return;
                    return (await profileRuntime()).api.saveQualification(
                      { lockVersion: null },
                      key,
                    );
                  })
                  .then(async (value) => {
                    if (value && action.isCurrent(context)) await load();
                  });
              }}
            >
              更改资质并重新审核
            </Button>
          ) : null}
          {qualificationKind(owner) === "new_store" ? (
            <Note>新门店沿用已认证主体的营业执照，本轮仅提交本店所需证照</Note>
          ) : (
            <Card title="主体类型">
              <View className="profile-pair">
                {(
                  [
                    ["enterprise", "企业"],
                    ["individual", "个体工商户"],
                  ] as const
                ).map(([value, title]) => (
                  <Checkbox
                    key={value}
                    shape="round"
                    checked={
                      round?.claimedEntityType === value ||
                      (!round && owner.entity.entityType === value)
                    }
                    disabled={!editable || action.busy || authorizing}
                    onChange={() => {
                      const body = {
                        lockVersion: round?.lockVersion ?? null,
                        claimedEntityType: value,
                      };
                      void action
                        .run(body, (key) =>
                          profileRuntime().then(({ api }) => api.saveQualification(body, key)),
                        )
                        .then(async (result) => {
                          if (result) await load();
                        });
                    }}
                  >
                    {title}
                  </Checkbox>
                ))}
              </View>
            </Card>
          )}
          {round?.kind !== "new_store" &&
          !(
            owner.entity.verificationStatus === "verified" &&
            owner.storeQualificationStatus === "unsubmitted" &&
            !round
          ) ? (
            <Certificate
              title="营业执照"
              docType="business_license"
              doc={
                round?.docs.find((doc) => doc.docType === "business_license") ??
                owner.effectiveDocs.find((doc) => doc.docType === "business_license")
              }
              permits={resource.data?.dicts[0]?.items ?? []}
              lockVersion={round?.lockVersion ?? 0}
              editable={editable && !authorizing}
              reload={load}
            />
          ) : null}
          {round?.kind === "new_store" &&
          !round.docs.some((d) => d.docType === "branch_license") ? (
            <Certificate
              title="分支机构执照（选填）"
              docType="branch_license"
              permits={resource.data?.dicts[0]?.items ?? []}
              lockVersion={round.lockVersion}
              editable={editable && !authorizing}
              reload={load}
            />
          ) : null}
          {owner.requiredPermits.map(({ permitType }) => (
            <Certificate
              key={permitType.code}
              title={permitType.name}
              docType="industry_permit"
              permitType={permitType.code}
              doc={
                round?.docs.find((doc) => doc.permitType?.code === permitType.code) ??
                owner.effectiveDocs.find((doc) => doc.permitType?.code === permitType.code)
              }
              permits={resource.data?.dicts[0]?.items ?? []}
              lockVersion={round?.lockVersion ?? 0}
              editable={editable && !authorizing}
              reload={load}
            />
          ))}
          {(round?.docs ?? [])
            .filter(
              (doc) =>
                doc.docType === "branch_license" ||
                (doc.docType === "industry_permit" &&
                  !owner.requiredPermits.some((p) => p.permitType.code === doc.permitType?.code)),
            )
            .map((doc) => (
              <Certificate
                key={doc.qualificationDocId}
                title={doc.permitType?.name ?? "分支机构执照"}
                docType={doc.docType === "industry_permit" ? "industry_permit" : "branch_license"}
                permitType={doc.permitType?.code}
                doc={doc}
                permits={resource.data?.dicts[0]?.items ?? []}
                lockVersion={round?.lockVersion ?? 0}
                editable={editable && !authorizing}
                reload={load}
              />
            ))}
          <Card title="资质联系人">
            <View className="profile-form">
              <TextField
                label="联系人姓名"
                value={name}
                max={20}
                required
                disabled={action.busy || sms.busy || authorizing}
                onChange={setName}
              />
              <View className="profile-subtitle">
                当前联系号码：{owner.contact.phoneMask ?? "未填写"}
              </View>
              <Checkbox
                shape="round"
                checked={phoneSource === "login"}
                disabled={action.busy || sms.busy || authorizing}
                onChange={() => setPhoneSource("login")}
              >
                使用登录号码 {owner.contact.loginPhoneMask}
              </Checkbox>
              <Checkbox
                shape="round"
                checked={phoneSource === "input"}
                disabled={action.busy || sms.busy || authorizing}
                onChange={() => setPhoneSource("input")}
              >
                使用其他号码
              </Checkbox>
              {phoneSource === "input" ? (
                <>
                  <TextField
                    label="联系人手机号"
                    value={phone}
                    max={11}
                    required
                    disabled={action.busy || sms.busy || authorizing}
                    onChange={setPhone}
                  />
                  {owner.contact.isSmsVerifyAvailable ? (
                    <>
                      <TextField
                        label="短信验证码"
                        value={smsCode}
                        onChange={setSmsCode}
                        max={6}
                        numeric
                        disabled={action.busy || sms.busy || authorizing}
                      />
                      <Button
                        variant="outline"
                        loading={sms.busy}
                        disabled={action.busy || authorizing || !!currentSms?.resendAt}
                        onClick={() => {
                          const context = profileContext();
                          void sms
                            .run({ phone }, (key) =>
                              profileRuntime().then(({ api }) => api.contactSms({ phone }, key)),
                            )
                            .then((value) => {
                              if (value && sms.isCurrent(context))
                                setSmsReceipt({
                                  context,
                                  phone,
                                  resendAt: value.resendAfterSec
                                    ? Date.now() + value.resendAfterSec * 1000
                                    : 0,
                                  message: value.isLoginPhone
                                    ? "这是当前登录手机号，无需验证码"
                                    : `验证码已发送，${value.resendAfterSec ?? 0}秒后可重发`,
                                });
                            });
                        }}
                      >
                        获取验证码
                      </Button>
                      {currentSms ? <Note>{currentSms.message}</Note> : null}
                    </>
                  ) : (
                    <Note>短信验证当前不可用，可按未验证号码保存，提交时由服务端复核</Note>
                  )}
                </>
              ) : null}
              {owner ? (
                <Button
                  variant="outline"
                  block
                  loading={action.busy}
                  disabled={authorizing || sms.busy}
                  onClick={() => {
                    const body = {
                      lockVersion: owner.contact.lockVersion,
                      name,
                      phoneSource,
                      ...(phoneSource === "input"
                        ? { phone, ...(smsCode ? { smsCode } : {}) }
                        : {}),
                    };
                    void action
                      .run(body, (key) =>
                        profileRuntime().then(({ api }) => api.saveContact(body, key)),
                      )
                      .then(async (value) => {
                        if (value) {
                          acceptContact(value);
                          resource.setData((old) =>
                            old && old.qualification.viewerRole === "owner"
                              ? { ...old, qualification: { ...old.qualification, contact: value } }
                              : old,
                          );
                          await load();
                        }
                      });
                  }}
                >
                  保存联系人
                </Button>
              ) : null}
            </View>
          </Card>
          {owner.actions.includes("discard") && round ? (
            <Button
              variant="danger"
              disabled={uploading || authorizing}
              loading={action.busy}
              onClick={() => {
                const context = profileContext(),
                  body = { qualificationSubmissionId: round.qualificationSubmissionId };
                void action
                  .run({ discard: body }, async (key) => {
                    const yes = await Taro.showModal({
                      title: "放弃本轮草稿",
                      content: "本轮未提交修改将放弃，历史审核与当前有效档案保留",
                    });
                    if (!yes.confirm || !action.isCurrent(context)) return;
                    return (await profileRuntime()).api.discard(body, key);
                  })
                  .then(async (value) => {
                    if (value && action.isCurrent(context)) await load();
                  });
              }}
            >
              放弃本轮修改
            </Button>
          ) : null}
          {editable ? (
            <Card title="信息确认">
              <Checkbox
                checked={agreed}
                disabled={!editable || action.busy || authorizing}
                onChange={saveDeclaration}
              >
                我确认所填信息与上传素材真实、合法，拥有使用权，并授权平台用于制作广告视频
              </Checkbox>
              <View className="profile-subtitle">确认版本：{owner.declaration.currentVersion}</View>
              <View className="profile-subtitle">勾选后自动保存，再次进入此页时需重新确认</View>
            </Card>
          ) : null}
          {editable && owner.actions.includes("submit") && round ? (
            <FooterBar>
              <Button
                block
                loading={authorizing}
                disabled={!agreed || uploading || action.busy}
                onClick={() => {
                  const context = profileContext();
                  if (
                    pendingAuthorization.current?.context === context ||
                    pendingDeclaration.current === context ||
                    !submit.isCurrent(context)
                  )
                    return;
                  const attempt = { context, key: declarationKey };
                  pendingAuthorization.current = attempt;
                  setAuthorizingContext(context);
                  const body = {
                    qualificationSubmissionId: round.qualificationSubmissionId,
                    declarationConfirmed: agreed,
                    declarationVersion: owner.declaration.currentVersion,
                  };
                  withProfileSubscribe("profile_submit", async () => {
                    try {
                      if (
                        pendingAuthorization.current !== attempt ||
                        !sameDeclaration(context, attempt.key)
                      )
                        return;
                      const value = await submit.run(body, (key) =>
                        profileRuntime().then(({ api }) => api.submit(body, key)),
                      );
                      if (value && submit.isCurrent(context)) {
                        setAgreed(false);
                        await submit.continueTo("review", context);
                      }
                    } finally {
                      if (pendingAuthorization.current === attempt) {
                        pendingAuthorization.current = null;
                      }
                      if (pendingAuthorization.current === null && submit.isContextCurrent(context))
                        setAuthorizingContext(null);
                    }
                  })();
                }}
              >
                提交资质审核
              </Button>
            </FooterBar>
          ) : null}
        </>
      ) : data ? (
        <Note>店员仅可查看门店资质状态，请联系老板完善证照</Note>
      ) : null}
    </Frame>
  );
}
