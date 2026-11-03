import { Button, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useState } from "react";
import type { PropsWithChildren } from "react";
import { baseUrl, errorCode, flushAttempts, isFake, pendingCount } from "./api";

export function Frame({
  title,
  children,
  locked = false,
}: PropsWithChildren<{ title: string; locked?: boolean }>) {
  const [mode, setMode] = useState("未连接");
  const [pending, setPending] = useState(0);
  useDidShow(() => {
    void isFake()
      .then((value) => setMode(value ? "FAKE：仅端点演练，不计真机结论" : "REAL：真实平台验证"))
      .catch((error) => setMode(errorCode(error)));
    setPending(pendingCount());
  });
  return (
    <View>
      <Text className="title">{title}</Text>
      <Text className="line muted">{mode}</Text>
      <Text className="line muted">服务：{baseUrl}</Text>
      <View className="nav">
        {[
          ["login", "V19 取号"],
          ["scan", "V8 扫码"],
          ["upload", "V3 上传"],
          ["download", "V7 下载"],
        ].map(([page, name]) => (
          <Button
            size="mini"
            key={page}
            disabled={locked}
            onClick={() => void Taro.redirectTo({ url: `/pages/${page}/index` })}
          >
            {name}
          </Button>
        ))}
      </View>
      {children}
      <Button
        onClick={() =>
          void flushAttempts()
            .catch(() => undefined)
            .finally(() => setPending(pendingCount()))
        }
      >
        补传脱敏记录（待传 {pending}）
      </Button>
      <Text className="line muted">
        界面只显示脱敏结果。测试前核对清单的设备、网络与次数；每次手机号成功取号会计费。
      </Text>
    </View>
  );
}
