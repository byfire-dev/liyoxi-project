import { NOTIFY_SCENES } from "@liyoxi/contract";
import { AppError } from "../kernel/index.js";
import type { NotifyDispatchDeps } from "./context.js";
import { EVENT_SCENES, FOLLOWUP_SPEC, UNREACHED_SPEC } from "./registry.js";
import { validWechatFields } from "./render.js";

/** Called by the awaited API/worker startup check; this factory starts no background work. */
export async function validateConfiguration(deps: NotifyDispatchDeps) {
  const actual = new Set([
    ...Object.values(EVENT_SCENES)
      .flat()
      .map((spec) => spec.sceneKey),
    FOLLOWUP_SPEC.sceneKey,
    UNREACHED_SPEC.sceneKey,
  ]);
  const problems = await deps.tx.run(async (tx) => {
    const scenes = await tx.notifyScene.findMany({
      select: { sceneKey: true, wxTemplateSlotKey: true },
    });
    const slots = await tx.wxTemplateSlot.findMany();
    const issues: { sceneKey: string; problem: string }[] = [];
    for (const spec of NOTIFY_SCENES) {
      const scene = scenes.find((row) => row.sceneKey === spec.key);
      if (!scene) issues.push({ sceneKey: spec.key, problem: "missing_scene" });
      else if (actual.has(spec.key) && scene.wxTemplateSlotKey) {
        const slot = slots.find((row) => row.slotKey === scene.wxTemplateSlotKey);
        if (
          !slot ||
          (slot.status === "active" &&
            (!slot.providerTemplateId || !validWechatFields(slot.slotKey, slot.fields)))
        )
          issues.push({ sceneKey: spec.key, problem: "invalid_template_fields" });
      }
    }
    return issues;
  });
  if (!problems.length) return;
  if (deps.appEnv !== "prod")
    throw new AppError("INTERNAL", { message: "通知启动配置不符合注册表", details: { problems } });
  for (const problem of problems) {
    deps.logger.warn({ evt: "notify.configuration_invalid", ...problem }, "通知场景或模板配置无效");
    await deps.alerts.raise({
      rule: "notify.configuration_invalid",
      dimension: problem.sceneKey,
      severity: "P2",
      detail: { ...problem },
    });
  }
}
