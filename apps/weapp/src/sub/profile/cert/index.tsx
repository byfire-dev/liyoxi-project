import { useUploadBusy } from "@/lib/upload/taro";
import { useRef, useState } from "react";
import { View } from "@tarojs/components";
import { useDidHide } from "@tarojs/taro";
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
import { errorInfo } from "../private/model";
export default function Cert() {
  const uploading = useUploadBusy();
  const resource = useResource(async (api) => ({
    qualification: await api.qualification(),
    dicts: await api.dict("permit_type"),
  }));
  const action = useAction("qualification_save", 4);
  const submit = useAction("qualification_submit");
  const pendingAuthorization = useRef<{ context: string; key: string } | null>(null);
  const pendingDeclaration = useRef<string | null>(null);
  const [authorizingContext, setAuthorizingContext] = useState<string | null>(null);
  const data = resource.data?.qualification;
  const owner = data?.viewerRole === "owner" ? data : null;
  const round = owner?.openRound;
  const editable =
    owner !== null &&
    !owner.isFinalRejected &&
    owner.storeQualificationStatus !== "verified" &&
    round?.phase !== "in_review";
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
  const setName = (name: string) => setContact((old) => ({ ...old, name }));
  const setPhoneSource = (phoneSource: "login" | "input") =>
    setContact((old) => ({ ...old, phoneSource }));
  const setPhone = (phone: string) => setContact((old) => ({ ...old, phone }));
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
      {owner ? (
        <>
          {!editable ? <Note>当前资料只读。审核进度与结果请到审核进度页查看</Note> : null}
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
                disabled={!editable || authorizing}
                onChange={setName}
              />
              <View className="profile-subtitle">
                当前联系号码：{owner.contact.phoneMask ?? "未填写"}
              </View>
              <Checkbox
                shape="round"
                checked={phoneSource === "login"}
                disabled={!editable || authorizing}
                onChange={() => setPhoneSource("login")}
              >
                使用登录号码 {owner.contact.loginPhoneMask}
              </Checkbox>
              <Checkbox
                shape="round"
                checked={phoneSource === "input"}
                disabled={!editable || authorizing}
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
                    disabled={!editable || authorizing}
                    onChange={setPhone}
                  />
                  <Note>短信核验暂未开放，提交后由审核员人工核对</Note>
                </>
              ) : null}
              {editable ? (
                <Button
                  variant="outline"
                  block
                  loading={action.busy}
                  disabled={authorizing}
                  onClick={() => {
                    const body = {
                      lockVersion: owner.contact.lockVersion,
                      name,
                      phoneSource,
                      ...(phoneSource === "input" ? { phone } : {}),
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
