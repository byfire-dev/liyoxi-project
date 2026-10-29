import { chainKey, machinePort, rowKey } from "../flow/index.js";
import type { MachineBinding } from "../flow/index.js";
import { implementKeyed } from "../kernel/index.js";
import { cancelPublishGuard } from "./cancel-review-close.js";
const pass = Symbol("publish.checked");
export const checked = () => pass;
const guards = (rows: ReadonlyArray<readonly [string, string]>) =>
  Object.fromEntries(
    rows.map(([ref, event]) => [
      rowKey(ref, event),
      async (_tx: unknown, facts: { args: unknown }) => facts.args === pass,
    ]),
  );
const account: MachineBinding = {
  companions: [
    "submitted_at",
    "verified_at",
    "verified_by_staff_id",
    "account_type",
    "cert_subject_name",
    "abnormal_source",
    "abnormal_reason_code",
    "abnormal_note",
  ],
  guards: guards([
    ["11:129", "account.bind"],
    ["11:130", "account.verify_pass"],
    ["11:131", "account.verify_reject"],
    ["11:132", "account.resubmit"],
  ]),
  activity: (f) => ({
    category: "review",
    action: `publish.channel_account.${f.event.split(".")[1]}`,
    summary: "渠道账号核验",
  }),
};
const launch: MachineBinding = {
  companions: [
    "current_round_no",
    "verified_episode_count",
    "first_launch_date",
    "completed_at",
    "is_live",
    "went_live_at",
    "void_reason",
  ],
  guards: {
    ...guards([
      ["11:299", "launch.create"],
      ["11:300", "launch.submit"],
      ["11:301", "launch.verify_pass"],
      ["11:302", "launch.return"],
    ]),
    [rowKey("11:304", "launch.void")]: cancelPublishGuard,
    [rowKey("11:305", "launch.settle")]: cancelPublishGuard,
  },
  activity: (f) => ({
    category: "review",
    action: `publish.launch_task.${f.event.split(".")[1]}`,
    summary: "上线记录核验",
  }),
};
export const publishMachines = [
  implementKeyed(machinePort, chainKey("channel_account", "status"), account),
  implementKeyed(machinePort, chainKey("launch_task", "review_status"), launch),
];
