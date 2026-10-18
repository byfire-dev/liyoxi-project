import { entry, type StatusToneGroup } from "./types.js";
// 规范6.1：技术队列等待执行为蓝；待人工决定为橙；失败/熔断为红。
export const mediaFiles: StatusToneGroup = {
  key: "media-files", object: "媒体文件", entries: [
    entry("待上传", "file_object.status", ["pending"], null, "info"),
    entry("入库中", "file_object.status", ["promoting"], null, "info"),
    entry("已入库", "file_object.status", ["stored"], null, "success"),
    entry("已拒收", "file_object.status", ["rejected"], null, "danger"),
    entry("已过期", "file_object.status", ["expired"], null, "danger"),
    entry("删除处理中", "file_object.status", ["deleting"], null, "info"),
    entry("已清除", "file_object.status", ["deleted"], null, "neutral"),
  ],
};
export const mediaPurges: StatusToneGroup = {
  key: "media-purges", object: "媒体清除运行", entries: [
    entry("待放行", "file_purge_run.state", ["proposed"], null, "warning"),
    entry("已熔断", "file_purge_run.state", ["held"], null, "danger"),
    entry("已放行 · 待执行", "file_purge_run.state", ["approved"], null, "info"),
    entry("执行中", "file_purge_run.state", ["running"], null, "info"),
    entry("执行完成", "file_purge_run.state", ["done"], null, "success"),
    entry("已中止", "file_purge_run.state", ["aborted"], null, "danger"),
    entry("已驳回", "file_purge_run.state", ["rejected"], null, "danger"),
  ],
};
export const mediaJobs: StatusToneGroup = {
  key: "media-jobs", object: "媒体任务", entries: [
    entry("待执行", "media_job.state", ["queued"], null, "info"),
    entry("执行中", "media_job.state", ["running"], null, "info"),
    entry("提交中", "media_job.state", ["submitting"], null, "info"),
    entry("已提交 · 待回调", "media_job.state", ["submitted"], null, "info"),
    entry("任务成功", "media_job.state", ["succeeded"], null, "success"),
    entry("任务失败", "media_job.state", ["failed"], null, "danger"),
    entry("已取消", "media_job.state", ["canceled"], null, "neutral"),
  ],
};
