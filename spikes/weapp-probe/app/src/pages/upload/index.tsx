import { Button, Text, View } from "@tarojs/components";
import { useDidHide, useDidShow } from "@tarojs/taro";
import { useState } from "react";
import { errorCode, report } from "../../lib/api";
import { Frame } from "../../lib/frame";
import {
  cancelUpload,
  chooseUpload,
  pauseUpload,
  recoverUpload,
  resumeUpload,
  upload,
} from "../../lib/upload";
import type { UploadView } from "../../lib/upload";

export default function UploadPage() {
  const [view, setView] = useState<UploadView>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [scenario, setScenario] = useState("baseline");
  useDidShow(() => {
    void recoverUpload();
    if (busy) setMessage("已回前台；观察 SDK 状态，必要时点恢复，失败后重新选择同一文件。");
  });
  useDidHide(() => {
    if (busy) setMessage("进入后台，保持本次上传以实测平台中断行为");
  });
  const begin = async (compressed: boolean, chat: boolean) => {
    if (busy) return;
    setBusy(true);
    setView(undefined);
    const started = Date.now();
    const name = compressed ? "compressed_reselect" : scenario;
    try {
      const file = await chooseUpload(compressed, chat);
      await upload(file, name, setView);
    } catch (error) {
      const code = errorCode(error);
      setMessage(code);
      await report({
        item: "V3",
        scenario: name,
        sizeBytes: 0,
        durationMs: Date.now() - started,
        result: code === "CANCELLED" ? "cancelled" : "failure",
        errorCode: code,
        phase: "choose_file",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="V3 分块上传与续传" locked={busy}>
      <Text className="line">4 MiB 分块 · 分块并发 2 · 文件并发 1 · 单请求 120 秒</Text>
      <Text className="line">场景：{scenario}</Text>
      <View className="nav">
        {["baseline", "background_resume", "process_reselect", "timeout"].map((value) => (
          <Button key={value} size="mini" disabled={busy} onClick={() => setScenario(value)}>
            {value}
          </Button>
        ))}
      </View>
      <Button disabled={busy} onClick={() => void begin(false, false)}>
        从相册选择原始视频 / 重选同一文件
      </Button>
      <Button disabled={busy} onClick={() => void begin(false, true)}>
        从聊天选择原始 MP4
      </Button>
      <Button disabled={busy} onClick={() => void begin(true, false)}>
        压缩后重选（比较摘要与续传）
      </Button>
      <View className="nav">
        <Button
          disabled={!busy}
          onClick={() => {
            pauseUpload();
            setMessage("已手动暂停；恢复仍为同一次尝试");
          }}
        >
          暂停
        </Button>
        <Button
          disabled={!busy}
          onClick={() => {
            resumeUpload();
            setMessage("已请求恢复");
          }}
        >
          恢复
        </Button>
        <Button disabled={!busy} onClick={cancelUpload}>
          取消
        </Button>
      </View>
      {view && (
        <View className="panel">
          <Text className="line">
            {view.state} · {view.percent}% · {(view.size / 1000000).toFixed(2)} MB
          </Text>
          <Text className="line">
            摘要 {view.fingerprint || "待计算"}；同文件记录 {view.matched ? "命中" : "新建"}
          </Text>
          <Text className="line">
            远端已完成 {view.partsObserved ? view.completedParts : "未知"}/{view.totalParts}
            ；本次发送 {view.sentParts}；重复已完成分块{" "}
            {view.partsObserved ? view.retransmittedParts : "未知"}
          </Text>
        </View>
      )}
      <Text className="line">{message}</Text>
      <Text className="line muted">
        未压缩重选应命中同一摘要与对象键。先上传部分分块再杀进程；复开后仍选择原始文件。完整上传之后再次选择属于新一轮完整上传，不能据此判断断点续传。已完成分块来自
        ListParts，实际发送来自 SDK 请求事件；未观测到列表时显示未知，不当作零。
      </Text>
    </Frame>
  );
}
