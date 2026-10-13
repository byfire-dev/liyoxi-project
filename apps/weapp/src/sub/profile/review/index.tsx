import { useUploadBusy } from "@/lib/upload/taro";
import { useRef, useState } from "react";
import { View } from "@tarojs/components";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { Note } from "@/components/Note";
import { Timeline } from "@/components/Timeline";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { withProfileSubscribe } from "../private/subscription";
import { appDateTimeFormat as fmtMerchant } from "@liyoxi/shared/format/datetime";
import { Frame, Feedback, navigate, useAction, useResource } from "../private/ui";
import { profileContext, profileRuntime } from "../private/runtime";
export default function Review() {
  const uploading = useUploadBusy();
  const resource = useResource(async (api) => {
    const qualification = await api.qualification();
    return {
      qualification,
      history: qualification.viewerRole === "owner" ? await api.rounds() : null,
    };
  });
  const historyAction = useAction("qualification_history");
  const action = useAction("qualification_resubmit");
  const pendingAuthorization = useRef<string | null>(null);
  const [authorizingContext, setAuthorizingContext] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const data = resource.data?.qualification;
  const owner = data?.viewerRole === "owner" ? data : null;
  const round = owner?.openRound ?? owner?.lastClosedRound;
  const tag =
    data && merchantStatusByEnum("store.qualification_status", data.storeQualificationStatus);
  const declarationKey = `${profileContext()}|${owner?.declaration.currentVersion ?? ""}|${owner?.openRound?.qualificationSubmissionId ?? ""}`;
  const [confirmedKey, setConfirmedKey] = useState(declarationKey);
  if (confirmedKey !== declarationKey) {
    setConfirmedKey(declarationKey);
    setAgreed(false);
  }
  return (
    <Frame
      loading={resource.loading}
      error={resource.error}
      retry={() => {
        void resource.load();
      }}
    >
      <Feedback
        action={action}
        refresh={() => {
          void resource.load();
        }}
      />
      <Feedback action={historyAction} />
      <Card
        title="审核进度"
        extra={tag ? <StatusTag tone={tag.tone}>{tag.label}</StatusTag> : undefined}
      >
        <View className="profile-spaced">
          {round?.dueAt && round.phase === "in_review" ? (
            <View>预计 {fmtMerchant.dateTime(round.dueAt)} 完成</View>
          ) : null}
          {round?.rejectReasons.map((reason) => (
            <Note key={reason.code} tone="danger">
              {reason.name}
            </Note>
          ))}
          {round?.decisionNote ? <Note tone="warning">{round.decisionNote}</Note> : null}
          {round?.systemRejectCode === "duplicate_entity" ? (
            <Note tone="danger">主体信息重复，请联系服务经理核对</Note>
          ) : null}
          <Timeline
            items={[
              ...(round?.submittedAt
                ? [
                    {
                      title: round.isResubmit ? "重新提交资质审核" : "提交资质审核",
                      time: fmtMerchant.dateTime(round.submittedAt),
                      state: "done" as const,
                    },
                  ]
                : []),
              ...(round?.decidedAt
                ? [
                    {
                      title: tag?.label ?? "已处理",
                      time: fmtMerchant.dateTime(round.decidedAt),
                      state: "done" as const,
                    },
                  ]
                : round?.phase === "in_review"
                  ? [
                      {
                        title: "平台审核中",
                        description: "结果将同步显示在本页",
                        state: "current" as const,
                      },
                    ]
                  : [{ title: "完善资质资料", state: "current" as const }]),
            ]}
          />
        </View>
      </Card>
      {owner && resource.data?.history ? (
        <Card title="历次审核记录">
          <View className="profile-spaced">
            {resource.data.history.items.map((r) => (
              <View key={r.qualificationSubmissionId}>
                <View>
                  第 {r.roundNo} 轮 ·{" "}
                  {r.kind === "change" ? "变更" : r.kind === "new_store" ? "新门店" : "首次认证"}
                  {r.isResubmit ? " · 补正重提" : ""}
                </View>
                <View className="profile-subtitle">
                  {fmtMerchant.dateTime(r.submittedAt)} · {r.outcome ?? "审核中"}
                </View>
                {r.rejectReasons.map((reason) => (
                  <Note key={reason.code}>{reason.name}</Note>
                ))}
                {r.decisionNote ? <Note>{r.decisionNote}</Note> : null}
              </View>
            ))}
            {resource.data.history.hasMore && resource.data.history.nextCursor ? (
              <Button
                variant="outline"
                loading={historyAction.busy}
                onClick={() => {
                  const cursor = resource.data?.history?.nextCursor,
                    context = profileContext();
                  if (!cursor) return;
                  void historyAction
                    .run({ cursor }, () => profileRuntime().then(({ api }) => api.rounds(cursor)))
                    .then((page) => {
                      if (!page || !historyAction.isCurrent(context)) return;
                      resource.setData((old) =>
                        !old?.history || old.history.nextCursor !== cursor
                          ? old
                          : {
                              ...old,
                              history: {
                                ...page,
                                items: [
                                  ...new Map(
                                    [...old.history.items, ...page.items].map((r) => [
                                      r.qualificationSubmissionId,
                                      r,
                                    ]),
                                  ).values(),
                                ],
                              },
                            },
                      );
                    });
                }}
              >
                查看更多审核记录
              </Button>
            ) : null}
          </View>
        </Card>
      ) : null}
      {owner?.openRound?.phase === "draft" ? (
        <Button variant="outline" onClick={() => navigate("cert")}>
          继续编辑本轮资质
        </Button>
      ) : null}
      {owner ? (
        <Card title="本次提交资料">
          <View className="profile-spaced">
            <View>
              主体名称：
              {owner.entity.name ??
                round?.docs.find((doc) => doc.docType === "business_license")?.holderName ??
                "待填写"}
            </View>
            <View>
              联系人：{round?.contactSnapshot?.name ?? owner.contact.name ?? "待填写"}{" "}
              {round?.contactSnapshot?.phoneMask ?? owner.contact.phoneMask}
            </View>
            {round?.docs.map((doc) => (
              <View className="profile-row" key={doc.qualificationDocId}>
                <View>
                  {doc.permitType?.name ??
                    (doc.docType === "business_license" ? "营业执照" : "分支机构执照")}
                </View>
                <View className="profile-subtitle">
                  {doc.verdict === "rejected"
                    ? "需补正"
                    : doc.hasSubmittedFields
                      ? "已核对"
                      : "请手动填写"}
                </View>
              </View>
            ))}
          </View>
        </Card>
      ) : null}
      {owner?.storeQualificationStatus === "rejected" && !owner.isFinalRejected ? (
        <>
          <Note tone="warning">请根据审核意见替换被驳回的证照，并核对本次信息</Note>
          <Button
            block
            variant="outline"
            loading={action.busy}
            onClick={() => {
              if (owner.openRound) navigate("cert");
              else {
                const body = { lockVersion: null };
                void action
                  .run(body, (key) =>
                    profileRuntime().then(({ api }) => api.saveQualification(body, key)),
                  )
                  .then((value) => {
                    if (value) navigate("cert");
                  });
              }
            }}
          >
            补正资质资料
          </Button>
          {owner.openRound && owner.actions.includes("submit") ? (
            <>
              <Checkbox checked={agreed} onChange={setAgreed}>
                我确认本次信息与素材真实、合法，拥有使用权，并授权平台用于制作广告视频
              </Checkbox>
              <Button
                block
                disabled={!agreed || uploading}
                loading={action.busy || authorizingContext === profileContext()}
                onClick={() => {
                  const context = profileContext();
                  if (pendingAuthorization.current === context || !action.isCurrent(context))
                    return;
                  pendingAuthorization.current = context;
                  setAuthorizingContext(context);
                  const body = {
                    qualificationSubmissionId: owner.openRound!.qualificationSubmissionId,
                    declarationConfirmed: agreed,
                    declarationVersion: owner.declaration.currentVersion,
                  };
                  withProfileSubscribe("profile_submit", async () => {
                    try {
                      if (!action.isCurrent(context)) return;
                      const value = await action.run(body, (key) =>
                        profileRuntime().then(({ api }) => api.submit(body, key)),
                      );
                      if (value && action.isCurrent(context)) {
                        setAgreed(false);
                        await resource.load();
                      }
                    } finally {
                      if (pendingAuthorization.current === context) {
                        pendingAuthorization.current = null;
                        if (action.isContextCurrent(context)) setAuthorizingContext(null);
                      }
                    }
                  })();
                }}
              >
                重新提交审核
              </Button>
            </>
          ) : null}
        </>
      ) : owner?.storeQualificationStatus === "unsubmitted" ? (
        <Button block onClick={() => navigate("cert")}>
          继续完善资质
        </Button>
      ) : null}
    </Frame>
  );
}
