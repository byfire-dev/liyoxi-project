import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Note } from "@/components/Note";
import { Sheet } from "@/components/Sheet";
import { TextArea } from "@/components/TextArea";
import { newIdempotencyKey } from "@/lib/runtime";
import { flagOn } from "@/stores/bootstrap";
import { deliveryScopeKey } from "@/stores/delivery";
import type { Sample } from "../components/delivery-api";
import type { useDeliveryResource } from "../components/resource";
import type { createSampleApi } from "./api";
import { createSampleFeedback } from "./feedback";
import type { FeedbackImage } from "./feedback";
import { FeedbackImages } from "./feedback-images";
export function SampleFeedbackForm({
  sample,
  currentSample,
  itemId,
  resource,
  api,
  visible,
  onClose,
}: {
  sample: NonNullable<Sample>;
  itemId: string;
  resource: ReturnType<typeof useDeliveryResource<Sample>>;
  currentSample(): Sample | null;
  api: ReturnType<typeof createSampleApi>;
  visible: boolean;
  onClose(): void;
}) {
  const [note, setNote] = useState(""),
    [files, setFiles] = useState<FeedbackImage[]>([]),
    [uploading, setUploading] = useState(false);
  const uploadBusy = useRef(false);
  const [model] = useState(() =>
    createSampleFeedback({
      api,
      scope: deliveryScopeKey,
      sample: currentSample,
      enabled: () => flagOn("weapp.video.sample.enabled"),
      key: () => newIdempotencyKey("sample_change"),
      itemId,
      replace: resource.replace,
    }),
  );
  useEffect(() => {
    model.mount();
    return model.dispose;
  }, [model]);
  const busyChanged = useCallback((value: boolean) => {
    uploadBusy.current = value;
    setUploading(value);
  }, []);
  return (
    <Sheet
      visible={visible}
      title={`第 ${sample.versionNo} 版合成修改`}
      onClose={() => {
        if (!resource.busy && !uploading) onClose();
      }}
      closeOnOverlayClick={!resource.busy && !uploading}
      footer={
        <Button
          block
          loading={resource.busy}
          disabled={uploading || !note.trim() || [...note.trim()].length > 200 || sample.isPaused}
          onClick={() => {
            if (!uploadBusy.current)
              resource.run(null, async (current) => {
                if (await model.submit(note, files, current)) onClose();
              });
          }}
        >
          提交合成修改意见
        </Button>
      }
    >
      <Note>用于字幕、画面、声音等合成问题。广告文案和内容修改请查看关联广告或联系服务经理。</Note>
      <TextArea
        value={note}
        onChange={setNote}
        maxLength={200}
        disabled={resource.busy || uploading}
        placeholder="请描述需要调整的合成问题（最多200字）"
      />
      <FeedbackImages
        files={files}
        onChange={setFiles}
        onBusy={busyChanged}
        disabled={resource.busy}
      />
    </Sheet>
  );
}
