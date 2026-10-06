import { useUploadBusy } from "@/lib/upload/taro";
import { useState } from "react";
import { View } from "@tarojs/components";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { FooterBar } from "@/components/FooterBar";
import { Note } from "@/components/Note";
import { StepBar } from "@/components/StepBar";
import { withSubscribe } from "@/lib/runtime";
import { Certificate } from "../private/certificates";
import { Frame, Feedback, TextField, STEP_NAMES, useAction, useResource } from "../private/ui";
import { useDraft } from "../private/draft";
import { profileRuntime } from "../private/runtime";
export default function Cert() {
  const uploading = useUploadBusy();
  const resource = useResource(async (api) => ({
    qualification: await api.qualification(),
    dicts: await api.dict("permit_type"),
  }));
  const action = useAction("qualification_save", 4);
  const submit = useAction("qualification_submit");
  const data = resource.data?.qualification;
  const owner = data?.viewerRole === "owner" ? data : null;
  const round = owner?.openRound;
  const editable =
    owner !== null &&
    !owner.isFinalRejected &&
    owner.storeQualificationStatus !== "verified" &&
    round?.phase !== "in_review";
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
  const declarationKey = `${owner?.declaration.currentVersion ?? ""}|${round?.qualificationSubmissionId ?? ""}`;
  const [confirmedKey, setConfirmedKey] = useState(declarationKey);
  if (confirmedKey !== declarationKey) {
    setConfirmedKey(declarationKey);
    setAgreed(false);
  }
  const load = async () => {
    await resource.load();
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
                  disabled={!editable || action.busy}
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
            editable={editable}
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
              editable={editable}
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
                editable={editable}
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
                disabled={!editable}
                onChange={setName}
              />
              <View className="profile-subtitle">
                当前联系号码：{owner.contact.phoneMask ?? "未填写"}
              </View>
              <Checkbox
                shape="round"
                checked={phoneSource === "login"}
                disabled={!editable}
                onChange={() => setPhoneSource("login")}
              >
                使用登录号码 {owner.contact.loginPhoneMask}
              </Checkbox>
              <Checkbox
                shape="round"
                checked={phoneSource === "input"}
                disabled={!editable}
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
                    disabled={!editable}
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
              <Checkbox checked={agreed} onChange={setAgreed}>
                我确认所填信息与上传素材真实、合法，拥有使用权，并授权平台用于制作广告视频
              </Checkbox>
              <View className="profile-subtitle">确认版本：{owner.declaration.currentVersion}</View>
            </Card>
          ) : null}
          {editable && owner.actions.includes("submit") && round ? (
            <FooterBar>
              <Button
                block
                loading={submit.busy}
                disabled={!agreed || uploading}
                onClick={withSubscribe("profile_submit", () => {
                  const body = {
                    qualificationSubmissionId: round.qualificationSubmissionId,
                    declarationConfirmed: agreed,
                    declarationVersion: owner.declaration.currentVersion,
                  };
                  void submit
                    .run(body, (key) => profileRuntime().then(({ api }) => api.submit(body, key)))
                    .then(async (value) => {
                      if (value) {
                        setAgreed(false);
                        await load();
                      }
                    });
                })}
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
