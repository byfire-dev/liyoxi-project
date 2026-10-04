// @ts-check
// 造片脚本与用例共用的常量：两边对同一份参数，用例里的期望值才对得上。

/** 测试片所在的任务目录（共享目录下的相对路径） */
export const FX = "fx";
/** 共享目录在容器里的挂载点 */
export const WORK = process.env.LYX_MEDIATOOL_WORK ?? "/work";

/** 标准竖屏片：1080×1920、30 帧、6 秒、H.264 High + AAC */
export const PORTRAIT = { width: 1080, height: 1920, fps: 30, seconds: 6, frames: 180 };
/** 横着编码、带旋转 90 度元数据的片子：显示出来是 1080×1920 */
export const ROTATED = { width: 1920, height: 1080, fps: 30, seconds: 3, frames: 90 };
/** 只有第一帧是同步帧的片子：抽末尾一帧要从头解码 */
export const SLOW = { fps: 30, seconds: 120 };
/** 耗时用的大片子：约 200MB、200 秒，码率约 8Mbps（D5 第 6.2 节：成片不超过 200MB） */
export const BIG = { seconds: 200, targetBytes: 200 * 1024 * 1024 };

/**
 * 写入用的 AIGC：七个字段（D5 第 12.1 节，GB 45438-2025）。
 * 取值全是占位：口径待法务定（D5 第 20 节 Q9），ProduceID 的格式留给 G3-A（任务书 第 11 节第 6 项）。
 */
export const AIGC = {
  Label: "1",
  ContentProducer: "LYX-X02-PLACEHOLDER",
  ProduceID: "lyx-x02-verify-0001",
  ReservedCode1: "",
  ContentPropagator: "",
  PropagateID: "",
  ReservedCode2: "",
};

/** 上游工具已经写好的标识（造“已带 AIGC 的一条”用），同样是占位值 */
export const UPSTREAM_AIGC = {
  Label: "1",
  ContentProducer: "UPSTREAM-TOOL-PLACEHOLDER",
  ProduceID: "upstream-0001",
  ReservedCode1: "",
  ContentPropagator: "",
  PropagateID: "",
  ReservedCode2: "",
};

/**
 * 把一个文件的访问时间拨回到这个时刻，下一次有人读它时内核会更新（relatime 也会）。
 * 之后访问时间还是它，就说明没有人读过这个文件。
 */
export const ARMED = new Date("2001-01-01T00:00:00Z");

export const AIGC_FIELDS = Object.keys(AIGC);
export const MB = 1024 * 1024;
