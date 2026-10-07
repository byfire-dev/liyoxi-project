import { CapsuleRadio, type CapsuleRadioProps } from "./CapsuleRadio";

export type ReasonChipsProps = Omit<CapsuleRadioProps, "appearance">;

/** 表单中的原因单选；由调用方提供原因和值，不认识驳回业务。 */
export function ReasonChips(props: ReasonChipsProps) {
  return <CapsuleRadio {...props} appearance="reason" />;
}
