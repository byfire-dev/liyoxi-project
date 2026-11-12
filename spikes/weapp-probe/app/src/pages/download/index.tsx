import { Button, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { useEffect, useState } from "react";
import { errorCode } from "../../lib/api";
import { Frame } from "../../lib/frame";
import {
  abandonDownloads,
  cleanResidualFiles,
  initializeDownloads,
  pauseDownloads,
  residualFiles,
  resolveUnknownDownload,
  resumeDownloads,
  retryFailedDownloads,
  startDownloads,
  subscribeDownloads,
} from "../../lib/download";
import type { DiskMode, Queue } from "../../lib/download";

export default function DownloadPage() {
  const [mode, setMode] = useState<DiskMode>("temp");
  const [size, setSize] = useState(30);
  const [scenario, setScenario] = useState("baseline");
  const [queue, setQueue] = useState<Queue>();
  const [message, setMessage] = useState("");
  const [residual, setResidual] = useState(0);
  useEffect(
    () =>
      subscribeDownloads((value) => {
        setQueue(value);
        setResidual(residualFiles());
      }),
    [],
  );
  useDidShow(() => {
    void initializeDownloads()
      .then(() => setResidual(residualFiles()))
      .catch((error) => setMessage(errorCode(error)));
  });
  useDidHide(() => pauseDownloads(false));
  const run = async (count: number) => {
    try {
      await startDownloads(
        count === 80 ? 50 : size,
        count,
        mode,
        count === 80 ? "continuous_80" : scenario,
      );
      setMessage("队列已开始；切后台后回前台点恢复。");
    } catch (error) {
      setMessage(errorCode(error));
    }
  };
  const inFlight = !!queue?.jobs.some(
    (job) => job.status === "downloading" || job.status === "saving",
  );
  const unfinished = !!queue?.jobs.some(
    (job) =>
      ["pending", "interrupted", "downloading", "saving"].includes(job.status) ||
      job.error === "SAVE_RESULT_UNKNOWN",
  );
  return (
    <Frame title="V7 下载与相册保存">
      <Text className="line">并发 2；每个文件保存后即清理；1 MB = 1,000,000 字节</Text>
      <View className="nav">
        {(["temp", "user_dir"] as const).map((value) => (
          <Button size="mini" key={value} disabled={unfinished} onClick={() => setMode(value)}>
            {value === mode ? "✓ " : ""}
            {value}
          </Button>
        ))}
      </View>
      <View className="nav">
        {[30, 60, 100, 150, 200].map((value) => (
          <Button size="mini" key={value} disabled={unfinished} onClick={() => setSize(value)}>
            {value === size ? "✓ " : ""}
            {value} MB
          </Button>
        ))}
      </View>
      <View className="nav">
        {["baseline", "background_resume", "low_storage"].map((value) => (
          <Button size="mini" key={value} disabled={unfinished} onClick={() => setScenario(value)}>
            {value === scenario ? "✓ " : ""}
            {value}
          </Button>
        ))}
      </View>
      <Button disabled={unfinished} onClick={() => void run(1)}>
        本档单次
      </Button>
      <Button disabled={unfinished} onClick={() => void run(3)}>
        本档连续 3 次
      </Button>
      <Button disabled={unfinished} onClick={() => void run(80)}>
        50 MB × 80 集（约 4 GB）
      </Button>
      <View className="nav">
        <Button disabled={!unfinished} onClick={() => pauseDownloads()}>
          暂停
        </Button>
        <Button disabled={!unfinished || inFlight} onClick={resumeDownloads}>
          恢复未完成项
        </Button>
      </View>
      <Button
        disabled={
          inFlight ||
          !queue?.jobs.some((job) => job.status === "failed" && job.error !== "SAVE_RESULT_UNKNOWN")
        }
        onClick={retryFailedDownloads}
      >
        手动重试明确失败项
      </Button>
      {queue?.jobs
        .filter((job) => job.error === "SAVE_RESULT_UNKNOWN")
        .map((job) => (
          <View className="panel" key={job.index}>
            <Text className="line">第 {job.index} 集的相册保存结果不明，请先在系统相册核对。</Text>
            <Button
              disabled={inFlight}
              onClick={() =>
                void resolveUnknownDownload(job.index, true).catch((error) =>
                  setMessage(errorCode(error)),
                )
              }
            >
              相册核对已保存
            </Button>
            <Button
              disabled={inFlight}
              onClick={() =>
                void resolveUnknownDownload(job.index, false).catch((error) =>
                  setMessage(errorCode(error)),
                )
              }
            >
              确认未保存后重试此项
            </Button>
          </View>
        ))}
      <Button
        disabled={inFlight || !unfinished}
        onClick={() => void abandonDownloads().catch((error) => setMessage(errorCode(error)))}
      >
        结束并记录未完成项为取消
      </Button>
      <Button onClick={() => void Taro.openSetting()}>打开相册权限设置</Button>
      {queue && (
        <View className="panel">
          <Text className="line">
            批次 {queue.runId} · {queue.sizeMb} MB · {queue.mode} · {queue.paused ? "暂停" : "运行"}
          </Text>
          <Text className="line">
            已保存 {queue.jobs.filter((job) => job.status === "saved").length}/{queue.jobs.length}
            ；失败 {queue.jobs.filter((job) => job.status === "failed").length}
          </Text>
          {queue.jobs
            .filter((job) => job.status !== "pending" && job.status !== "saved")
            .map((job) => (
              <Text className="line" key={job.index}>
                第 {job.index} 集：{job.status} {job.error}
              </Text>
            ))}
        </View>
      )}
      <Text className="line">探针已知残留文件：{residual}</Text>
      <Button
        disabled={inFlight}
        onClick={() =>
          void cleanResidualFiles()
            .then(() => setMessage("已清理探针已知残留文件"))
            .catch((error) => setMessage(errorCode(error)))
            .finally(() => setResidual(residualFiles()))
        }
      >
        重试清理残留
      </Button>
      <Text className="line">{message}</Text>
      <Text className="line muted">
        系统剩余存储请按清单在系统设置中记录。本探针计数只覆盖自身跟踪的文件，不能代表微信全部缓存。FAKE
        显示“已保存”仅表示签地址端点完成，不下载、不写相册。
      </Text>
    </Frame>
  );
}
