import { useCallback, useRef, useState } from "react";
import { View } from "@tarojs/components";
import { formatInteger } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { Chip } from "@/components/Chip";
import { Note } from "@/components/Note";
import { Sheet } from "@/components/Sheet";
import { TextArea } from "@/components/TextArea";
import { adApi, type Ad } from "./api";
import { assertSameVersion, changeBody } from "./model";
import type { useAdResource } from "./resource";
import { AdImages, type AdImage } from "./images";
import { AdReferences } from "./references";
type Resource = ReturnType<typeof useAdResource<Ad>>;
export function AdChangeForm({ ad, r, close }: { ad: Ad; r: Resource; close(): void }) {
  const [note, setNote] = useState(""),
    [segment, setSegment] = useState<number | null>(null),
    [files, setFiles] = useState<AdImage[]>([]),
    [accepted, setAccepted] = useState<number | null>(null),
    [uploading, setUploading] = useState(false);
  const uploadBusy = useRef(false),
    busyChanged = useCallback((value: boolean) => {
      uploadBusy.current = value;
      setUploading(value);
    }, []);
  return (
    <Sheet
      visible
      title={`修改第${ad.currentVersionNo}版广告`}
      onClose={() => {
        if (!r.busy && !uploading) close();
      }}
      closeOnOverlayClick={!r.busy && !uploading}
      footer={
        <Button
          block
          loading={r.busy}
          disabled={
            uploading ||
            !note.trim() ||
            (ad.freeRevisionsRemaining === 0 &&
              (accepted === null || accepted !== ad.revisionUnitChargePoints))
          }
          onClick={() =>
            r.run(async (current) => {
              if (uploadBusy.current) return;
              const fresh = await adApi.get(ad.adId);
              if (!current()) return;
              r.replace(fresh, current);
              assertSameVersion(ad, fresh);
              const body = changeBody(
                fresh,
                note,
                segment,
                files.map((file) => file.fileId),
                accepted,
              );
              await adApi.change(ad.adId, body, r.intent("adChange", body));
              if (!current()) return;
              const actual = await adApi.get(ad.adId);
              if (current()) {
                r.replace(actual, current);
                close();
              }
            })
          }
        >
          提交广告修改意见
        </Button>
      }
    >
      {r.error ? <Note tone="warning">{r.error}</Note> : null}
      <Note>剩余免费修改{ad.freeRevisionsRemaining}次。广告内容修改与样片合成问题分开处理。</Note>
      <View className="ad-options">
        <Chip
          selected={segment === null}
          disabled={r.busy || uploading}
          onClick={() => {
            setAccepted(null);
            setSegment(null);
          }}
        >
          整条广告
        </Chip>
        {ad.currentVersion?.segments.map((item) => (
          <Chip
            key={item.index}
            selected={segment === item.index}
            disabled={r.busy || uploading}
            onClick={() => {
              setAccepted(null);
              setSegment(item.index);
            }}
          >
            {item.label} · {item.fromMs / 1000}～{item.toMs / 1000}秒
          </Chip>
        ))}
      </View>
      <TextArea
        value={note}
        onChange={(value) => {
          setAccepted(null);
          setNote(value);
        }}
        maxLength={200}
        disabled={r.busy || uploading}
        placeholder="请描述广告需要修改的内容（最多200字）"
      />
      <AdImages
        files={files}
        onChange={(value) => {
          setAccepted(null);
          setFiles(value);
        }}
        onBusy={busyChanged}
        max={Math.min(9, ad.revisionScreenshotMax)}
        disabled={r.busy}
      />
      {ad.freeRevisionsRemaining === 0 ? (
        <>
          <Note tone="warning">
            本次超出免费次数，需扣减
            {ad.revisionUnitChargePoints === null
              ? "待刷新确认的"
              : formatInteger(ad.revisionUnitChargePoints)}
            积分。
          </Note>
          <Checkbox
            checked={accepted !== null && accepted === ad.revisionUnitChargePoints}
            disabled={r.busy || ad.revisionUnitChargePoints === null}
            onChange={(value) => setAccepted(value ? ad.revisionUnitChargePoints : null)}
          >
            我同意本次修改扣减
            {ad.revisionUnitChargePoints === null
              ? "—"
              : formatInteger(ad.revisionUnitChargePoints)}
            积分
          </Checkbox>
        </>
      ) : null}
    </Sheet>
  );
}
export function AdResubmitForm({ ad, r, close }: { ad: Ad; r: Resource; close(): void }) {
  const [copy, setCopy] = useState(ad.copy ?? ""),
    [remark, setRemark] = useState(ad.remark ?? ""),
    [refs, setRefs] = useState<string[]>([]);
  return (
    <Sheet
      visible
      title="补充后重新提交"
      onClose={() => {
        if (!r.busy) close();
      }}
      closeOnOverlayClick={!r.busy}
      footer={
        <Button
          block
          loading={r.busy}
          onClick={() =>
            r.run(async (current) => {
              const fresh = await adApi.get(ad.adId);
              if (!current()) return;
              r.replace(fresh, current);
              assertSameVersion(ad, fresh);
              if (!fresh.actions.includes("submit")) throw new Error("广告已不能重新提交，请刷新");
              const body = {
                copy: copy.trim() || null,
                remark: remark.trim() || null,
                ...(refs.length ? { addReferenceStoreAssetIds: refs } : {}),
              };
              await adApi.submit(ad.adId, body, r.intent("adResubmit", body));
              if (!current()) return;
              const actual = await adApi.get(ad.adId);
              if (current()) {
                r.replace(actual, current);
                close();
              }
            })
          }
        >
          重新提交广告需求
        </Button>
      }
    >
      {r.error ? <Note tone="warning">{r.error}</Note> : null}
      <Note>
        退回原因：{ad.returnReason ?? "请按服务经理要求补充素材"}。重新提交不会重复冻结原需求积分。
      </Note>
      <TextArea
        value={copy}
        onChange={setCopy}
        maxLength={50}
        disabled={r.busy}
        placeholder="广告文案（最多50字）"
      />
      <TextArea
        value={remark}
        onChange={setRemark}
        maxLength={200}
        disabled={r.busy}
        placeholder="补充制作要求（最多200字）"
      />
      <AdReferences selected={refs} change={setRefs} disabled={r.busy} />
    </Sheet>
  );
}
