// 时长的显示格式（规范 第 7 节“时长”一行）：mm:ss，两位分钟。“0:42”“1:35”这类一位分钟的写法不用。

/** 秒数 → mm:ss。不足一秒的部分舍去；满 100 分钟时分钟位照实写（100:05），不进位成小时 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    throw new RangeError(`时长须是不小于 0 的秒数，收到 ${totalSeconds}`);
  }
  const whole = Math.floor(totalSeconds);
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** 毫秒数 → mm:ss（接口里的时长字段是 durationMs） */
export function formatDurationMs(totalMs: number): string {
  return formatDuration(totalMs / 1000);
}
