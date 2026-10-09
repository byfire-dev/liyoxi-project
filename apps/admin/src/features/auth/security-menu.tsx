import { Alert, Button, Checkbox, Input, Modal, QRCode } from "antd";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { AppServices } from "../../app/services";
import { FormField } from "../../components/FormField";
import { accessEmpty, accessResult, writeIntent } from "../system/staff-access";
import type { components } from "@liyoxi/contract/types/admin";

export type SecurityMode = "password" | "totp" | "wecom";
type Enrollment = components["schemas"]["TotpReEnrollment"];
export function securityMenuItems(actions: readonly string[], pending: boolean) {
  return [
    { key: "password", label: "修改密码", disabled: pending },
    ...(actions.includes("self.mfa.reset")
      ? [{ key: "totp", label: "动态口令设置", disabled: pending }]
      : []),
    { key: "wecom", label: "绑定企业微信", disabled: pending },
    { key: "logout", label: "退出登录", disabled: pending },
  ];
}
export function pendingEnrollmentLive(enrollment: Enrollment | undefined, now = Date.now()) {
  return Boolean(enrollment && Date.parse(enrollment.pendingExpiresAt) > now);
}
export function SecurityDialog({
  mode,
  services,
  close,
}: {
  mode: SecurityMode;
  services: AppServices;
  close: () => void;
}) {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setPassword] = useState("");
  const [wecomUserid, setWecom] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [recovery, setRecovery] = useState<readonly string[]>();
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const [finished, setFinished] = useState(false);
  const canClose = !recovery || saved;
  const locked = useRef(false),
    alive = useRef(true);
  const [intent] = useState(() => writeIntent(`self-${mode}`));
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enrollment) return;
    const timeout = window.setTimeout(
      () => {
        setEnrollment(undefined);
        setCode("");
        setMessage("待确认密钥已过期，请重新生成。");
      },
      Math.max(0, Date.parse(enrollment.pendingExpiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [enrollment]);
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    setMessage(undefined);
    try {
      await action();
    } catch (error) {
      if (alive.current)
        setMessage(error instanceof Error ? error.message : "请求没有成功，请重试");
    } finally {
      locked.current = false;
      if (alive.current) setPending(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (mode === "password") {
        const value = { currentPassword, newPassword };
        await intent.run(value, async (key) =>
          accessEmpty(
            await services.api.client.POST("/api/v1/admin/auth/change-password", {
              body: value,
              headers: { "Idempotency-Key": key },
            }),
          ),
        );
        if (alive.current) {
          setCurrent("");
          setPassword("");
          setMessage("密码已修改，其他会话已失效。");
          setFinished(true);
        }
      } else if (mode === "wecom") {
        const body = { wecomUserid: wecomUserid.trim() };
        const result = await intent.run(body, async (key) =>
          accessResult(
            await services.api.client.POST("/api/v1/admin/auth/bind-wecom", {
              body,
              headers: { "Idempotency-Key": key },
            }),
          ),
        );
        if (alive.current && result) {
          setWecom("");
          setMessage(`企业微信状态：${result.status === "bound" ? "已绑定" : result.status}`);
          setFinished(true);
        }
      } else if (enrollment && pendingEnrollmentLive(enrollment)) {
        const result = await intent.run(
          { code, pendingExpiresAt: enrollment.pendingExpiresAt },
          async (key) =>
            accessResult(
              await services.api.client.POST("/api/v1/admin/auth/me/confirm-totp", {
                body: { code },
                headers: { "Idempotency-Key": key },
              }),
            ),
        );
        if (alive.current && result) {
          setEnrollment(undefined);
          setCode("");
          setRecovery(result.recoveryCodes ?? undefined);
          setFinished(Boolean(result.replayed || !result.recoveryCodes));
          setMessage(
            result.replayed || !result.recoveryCodes
              ? "本次是重放结果，恢复码不再展示；请关闭弹层后重新绑定以获取新的恢复码。"
              : "新动态口令已生效，旧密钥和恢复码已失效。请保存下方一次性恢复码。",
          );
        }
      }
    });
  };
  const titles = { password: "修改密码", totp: "动态口令设置", wecom: "绑定企业微信" };
  if (finished)
    return (
      <Modal open title={titles[mode]} footer={null} destroyOnHidden onCancel={close}>
        <Alert type="success" title={message} role="status" />
        <div className="lyx-confirm__footer">
          <Button size="large" type="primary" onClick={close}>
            关闭
          </Button>
        </div>
      </Modal>
    );
  return (
    <Modal
      open
      title={titles[mode]}
      footer={null}
      destroyOnHidden
      onCancel={canClose ? close : undefined}
      closable={canClose}
      mask={{ closable: canClose }}
      keyboard={canClose}
    >
      {message ? <Alert type="info" title={message} role="status" /> : null}
      <form aria-label={titles[mode]} className="lyx-auth-form" onSubmit={submit}>
        {mode === "password" ? (
          <>
            <FormField label="当前密码">
              {(props) => (
                <Input.Password
                  {...props}
                  autoComplete="current-password"
                  value={currentPassword}
                  required
                  disabled={pending}
                  onChange={(event) => setCurrent(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="新密码">
              {(props) => (
                <Input.Password
                  {...props}
                  autoComplete="new-password"
                  value={newPassword}
                  minLength={10}
                  maxLength={128}
                  required
                  disabled={pending}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </FormField>
            <p>至少10位，包含字母和数字；修改后其他会话失效。</p>
          </>
        ) : mode === "wecom" ? (
          <>
            <p>录入本人企业微信账号，确认归属后绑定。扫码入口暂不开放。</p>
            <FormField label="企业微信账号">
              {(props) => (
                <Input
                  {...props}
                  value={wecomUserid}
                  autoComplete="off"
                  maxLength={64}
                  required
                  disabled={pending}
                  onChange={(event) => setWecom(event.target.value)}
                />
              )}
            </FormField>
          </>
        ) : recovery ? (
          <>
            <div className="lyx-recovery-codes" aria-label="本人恢复码">
              {recovery.map((item) => (
                <code key={item}>{item}</code>
              ))}
            </div>
            <Checkbox checked={saved} onChange={(event) => setSaved(event.target.checked)}>
              我已保存恢复码
            </Checkbox>
          </>
        ) : enrollment ? (
          <>
            <p>确认前原动态口令仍有效；确认后旧密钥和恢复码失效。</p>
            <QRCode value={enrollment.otpauthUri} size={180} />
            <FormField label="手输密钥">
              {(props) => (
                <Input {...props} readOnly value={enrollment.secret} autoComplete="off" />
              )}
            </FormField>
            <FormField label="新动态口令">
              {(props) => (
                <Input
                  {...props}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  disabled={pending}
                  autoComplete="off"
                />
              )}
            </FormField>
          </>
        ) : (
          <>
            <p>重新绑定需要再验证；新密钥仅保留在当前弹层，关闭后清除。</p>
            <Button
              loading={pending}
              onClick={() =>
                void run(async () => {
                  const result = await accessResult(
                    await services.api.client.POST("/api/v1/admin/auth/me/enroll-totp"),
                  );
                  if (alive.current) {
                    setEnrollment(result);
                    setCode("");
                  }
                })
              }
            >
              生成新密钥
            </Button>
          </>
        )}
        <div className="lyx-confirm__footer">
          {!recovery ? (
            <Button size="large" onClick={close}>
              关闭
            </Button>
          ) : null}
          {recovery ? (
            <Button size="large" type="primary" disabled={!saved} onClick={close}>
              已保存，关闭
            </Button>
          ) : mode !== "totp" || enrollment ? (
            <Button size="large" type="primary" htmlType="submit" loading={pending}>
              确认{mode === "password" ? "修改" : "绑定"}
            </Button>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}
