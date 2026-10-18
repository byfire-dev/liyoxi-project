import { Alert, Button, Checkbox, Dropdown, Input, Modal, QRCode, Radio, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext, useRouter } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";

import { ACCESS_QUERY_KEY, type AppServices } from "../../app/services";
import { showApiNotice } from "../../app/feedback";
import { FormField } from "../../components/FormField";
import { readFailure } from "../../lib/api-errors";
import type { AccessSnapshot } from "../../lib/permissions";
import { actorScope } from "../system/staff-access";
import { SecurityDialog, securityMenuItems, type SecurityMode } from "./security-menu";

import {
  accessFromMe,
  authTicket,
  liveTicket,
  nextPath,
  safeRedirect,
  useAuthTicket,
  type AuthNext,
  type MeAccess,
} from "./model";

const PASSWORD_RULE_LABELS: Record<string, string> = {
  min_length: "至少 10 位",
  letters_and_digits: "同时包含字母和数字",
  contains_phone: "不能包含登录手机号",
  weak_password: "请换一个不常见的密码",
  same_as_current: "不能与原密码相同",
};

async function failureText(response: Response): Promise<string> {
  const failure = await readFailure(response);
  if (failure.symbol === "AUTH_TICKET_INVALID") authTicket.set(null);
  const details = failure.body?.details;
  if (
    failure.symbol === "PASSWORD_POLICY_VIOLATED" &&
    details &&
    typeof details === "object" &&
    "rules" in details &&
    Array.isArray(details.rules)
  ) {
    return details.rules
      .map((rule: unknown) =>
        typeof rule === "string" ? (PASSWORD_RULE_LABELS[rule] ?? rule) : "",
      )
      .filter(Boolean)
      .join("；");
  }
  return failure.message;
}
function useSubmit() {
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请求没有成功，请重试");
    } finally {
      locked.current = false;
      setPending(false);
    }
  };
  return { pending, error, run, setError };
}
function useAuthNavigation() {
  const router = useRouter();
  const { services } = useRouteContext({ from: "__root__" });
  const redirect = safeRedirect(
    new URLSearchParams(router.state.location.searchStr).get("redirect"),
  );
  const go = useCallback(
    (path: string) => router.history.push(`${path}?redirect=${encodeURIComponent(redirect)}`),
    [router, redirect],
  );
  const next = (value: AuthNext) => {
    authTicket.set(value.next === "login" ? null : value);
    go(nextPath(value.next));
  };
  const finish = async (me: MeAccess) => {
    services.queryClient.clear();
    services.queryClient.setQueryData(ACCESS_QUERY_KEY, accessFromMe(me));
    services.api.resetLoginLatch();
    authTicket.set(null);
    router.history.replace(redirect);
    await router.invalidate();
  };
  return { services, go, next, finish };
}
function useRequiredTicket(purpose: AuthNext["next"]) {
  const value = useAuthTicket();
  const { go } = useAuthNavigation();
  const ticket = liveTicket(value, purpose);
  useEffect(() => {
    if (!ticket) {
      authTicket.set(null);
      go("/login");
      return;
    }
    const timeout = window.setTimeout(
      () => {
        authTicket.set(null);
        go("/login");
      },
      Math.max(0, Date.parse(value?.ticketExpiresAt ?? "") - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [ticket, value?.ticketExpiresAt, go]);
  return ticket;
}
function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="lyx-auth">
      <section className="lyx-auth-card" aria-labelledby="auth-title">
        <div className="lyx-auth-brand">
          狸有戏<span>运营管理后台</span>
        </div>
        <h1 id="auth-title">{title}</h1>
        <p className="lyx-auth-description">{description}</p>
        {children}
      </section>
    </main>
  );
}
function ErrorMessage({ error }: { error?: string }) {
  return error ? <Alert type="error" title={error} showIcon role="alert" /> : null;
}
function PhoneField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <FormField label="手机号" value={value} maxLength={11}>
      {(props) => (
        <Input
          {...props}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          autoComplete="username"
          inputMode="tel"
          maxLength={11}
          required
          pattern="1[0-9]{10}"
        />
      )}
    </FormField>
  );
}
function PasswordField({
  value,
  onChange,
  disabled,
  first = false,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  first?: boolean;
  error?: string;
}) {
  return (
    <FormField label={first ? "新密码" : "密码"} value={value} maxLength={128} error={error}>
      {(props) => (
        <Input.Password
          {...props}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          autoComplete={first ? "new-password" : "current-password"}
          maxLength={128}
          required
        />
      )}
    </FormField>
  );
}
function FactorField({
  method,
  setMethod,
  code,
  setCode,
  pending,
}: {
  method: "totp" | "recovery";
  setMethod: (value: "totp" | "recovery") => void;
  code: string;
  setCode: (value: string) => void;
  pending: boolean;
}) {
  return (
    <>
      <Radio.Group
        aria-label="验证方式"
        value={method}
        disabled={pending}
        onChange={(event) => {
          setMethod(event.target.value as "totp" | "recovery");
          setCode("");
        }}
        options={[
          { value: "totp", label: "动态口令" },
          { value: "recovery", label: "恢复码" },
        ]}
      />
      <FormField
        label={method === "totp" ? "6 位动态口令" : "恢复码"}
        value={code}
        maxLength={method === "totp" ? 6 : 11}
      >
        {(props) => (
          <Input
            {...props}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={pending}
            autoComplete="one-time-code"
            inputMode={method === "totp" ? "numeric" : "text"}
            maxLength={method === "totp" ? 6 : 11}
            required
            pattern={method === "totp" ? "[0-9]{6}" : "[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}"}
          />
        )}
      </FormField>
    </>
  );
}
export function LoginPage() {
  const { services, go, next } = useAuthNavigation();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const submit = useSubmit();
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit.run(async () => {
      const { data, response } = await services.api.client.POST("/api/v1/admin/auth/login", {
        body: { phone, password },
      });
      if (!data) throw new Error(await failureText(response));
      next(data.data);
    });
  };
  return (
    <AuthCard title="登录后台" description="输入手机号和密码，下一步验证动态口令。">
      <form aria-label="后台登录" onSubmit={onSubmit} className="lyx-auth-form">
        <PhoneField value={phone} onChange={setPhone} disabled={submit.pending} />
        <PasswordField value={password} onChange={setPassword} disabled={submit.pending} />
        <ErrorMessage error={submit.error} />
        <Button type="primary" htmlType="submit" block loading={submit.pending}>
          下一步
        </Button>
      </form>
      <Button
        type="link"
        className="lyx-auth-link"
        disabled={submit.pending}
        onClick={() => go("/login/set-password")}
      >
        首次登录，激活账号
      </Button>
    </AuthCard>
  );
}
export function MfaPage() {
  const ticket = useRequiredTicket("mfa");
  const { services, go, finish } = useAuthNavigation();
  const [method, setMethod] = useState<"totp" | "recovery">("totp");
  const [code, setCode] = useState("");
  const submit = useSubmit();
  return (
    <AuthCard title="验证动态口令" description="打开动态口令验证器，或使用一个未用过的恢复码。">
      <form
        aria-label="登录验证"
        className="lyx-auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ticket)
            void submit.run(async () => {
              const { data, response } = await services.api.client.POST(
                "/api/v1/admin/auth/verify-mfa",
                { body: { ticket, method, code } },
              );
              if (!data) throw new Error(await failureText(response));
              await finish(data.data);
            });
        }}
      >
        <FactorField {...{ method, setMethod, code, setCode }} pending={submit.pending} />
        <ErrorMessage error={submit.error} />
        <Button type="primary" htmlType="submit" block loading={submit.pending} disabled={!ticket}>
          登录
        </Button>
      </form>
      <Button
        type="link"
        className="lyx-auth-link"
        disabled={submit.pending}
        onClick={() => {
          authTicket.set(null);
          go("/login");
        }}
      >
        返回登录
      </Button>
    </AuthCard>
  );
}
export function ActivationPage() {
  const { services, next, go } = useAuthNavigation();
  const stored = useAuthTicket();
  const [phone, setPhone] = useState("");
  const [activationCode, setCode] = useState("");
  const [password, setPassword] = useState("");
  const submit = useSubmit();
  return (
    <AuthCard title="激活账号" description="向管理员取得激活码，设置密码后绑定动态口令。">
      <form
        aria-label="激活账号"
        className="lyx-auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit.run(async () => {
            let ticket = liveTicket(stored, "set_password");
            if (!ticket) {
              const { data, response } = await services.api.client.POST(
                "/api/v1/admin/auth/activate",
                { body: { phone, activationCode } },
              );
              if (!data) throw new Error(await failureText(response));
              authTicket.set(data.data);
              ticket = liveTicket(data.data, "set_password");
              if (!ticket) {
                next(data.data);
                return;
              }
            }
            const { data, response } = await services.api.client.POST(
              "/api/v1/admin/auth/set-password",
              { body: { ticket, newPassword: password } },
            );
            if (!data) throw new Error(await failureText(response));
            next(data.data);
          });
        }}
      >
        <PhoneField
          value={phone}
          onChange={setPhone}
          disabled={submit.pending || Boolean(liveTicket(stored, "set_password"))}
        />
        <FormField label="激活码" value={activationCode} maxLength={8}>
          {(props) => (
            <Input
              {...props}
              value={activationCode}
              onChange={(event) => setCode(event.target.value)}
              disabled={submit.pending || Boolean(liveTicket(stored, "set_password"))}
              maxLength={8}
              required
              pattern="[A-Za-z0-9]{8}"
              autoComplete="off"
            />
          )}
        </FormField>
        <PasswordField
          value={password}
          onChange={setPassword}
          disabled={submit.pending}
          first
          error={submit.error}
        />
        <p className="lyx-auth-hint">
          至少 10 位，包含字母和数字，不能包含手机号或使用常见弱密码。
        </p>
        <Button type="primary" htmlType="submit" block loading={submit.pending}>
          设置密码并继续
        </Button>
      </form>
      <Button
        type="link"
        className="lyx-auth-link"
        disabled={submit.pending}
        onClick={() => {
          authTicket.set(null);
          go("/login");
        }}
      >
        返回登录
      </Button>
    </AuthCard>
  );
}
export function EnrollmentPage() {
  const value = useAuthTicket();
  const { services, go, finish } = useAuthNavigation();
  const ticket = value?.next === "enroll_totp" ? value.ticket : null;
  const [code, setCode] = useState("");
  const [confirmed, setConfirmed] = useState<{ me: MeAccess; recoveryCodes: string[] }>();
  const [saved, setSaved] = useState(false);
  const submit = useSubmit();
  const enrollment = useQuery({
    queryKey: ["auth", "enroll", ticket],
    enabled: Boolean(liveTicket(value, "enroll_totp")) && !confirmed,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const { data, response } = await services.api.client.POST("/api/v1/admin/auth/enroll-totp", {
        body: { ticket: ticket! },
      });
      if (!data) throw new Error(await failureText(response));
      return data.data;
    },
  });
  useEffect(() => {
    if (confirmed) return;
    const expiresAt = enrollment.data?.ticketExpiresAt ?? value?.ticketExpiresAt;
    if (!ticket || !expiresAt || Date.parse(expiresAt) <= Date.now()) {
      authTicket.set(null);
      go("/login");
      return;
    }
    const timeout = window.setTimeout(
      () => {
        authTicket.set(null);
        go("/login");
      },
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [confirmed, ticket, value?.ticketExpiresAt, enrollment.data?.ticketExpiresAt, go]);
  if (confirmed)
    return (
      <AuthCard
        title="保存恢复码"
        description="验证器无法使用时，可用恢复码登录。每个码只能使用一次。"
      >
        <div className="lyx-recovery-codes" aria-label="恢复码清单">
          {confirmed.recoveryCodes.map((item) => (
            <code key={item}>{item}</code>
          ))}
        </div>
        <p className="lyx-auth-hint">
          这 10 个恢复码只展示一次。请保存在安全的地方，不要转交给他人。
        </p>
        <Checkbox checked={saved} onChange={(event) => setSaved(event.target.checked)}>
          我已保存恢复码
        </Checkbox>
        <Button
          className="lyx-auth-continue"
          type="primary"
          block
          disabled={!saved}
          loading={submit.pending}
          onClick={() => void submit.run(() => finish(confirmed.me))}
        >
          进入后台
        </Button>
        <ErrorMessage error={submit.error} />
      </AuthCard>
    );
  return (
    <AuthCard title="绑定动态口令" description="用动态口令验证器扫描二维码，或手动输入下方密钥。">
      {enrollment.isPending ? (
        <Spin aria-label="正在准备绑定" />
      ) : enrollment.data ? (
        <>
          <div className="lyx-auth-qr">
            <QRCode value={enrollment.data.otpauthUri} size={180} />
          </div>
          <FormField label="手输密钥">
            {(props) => (
              <Input {...props} value={enrollment.data.secret} readOnly autoComplete="off" />
            )}
          </FormField>
          <form
            aria-label="绑定动态口令"
            className="lyx-auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit.run(async () => {
                const { data, response } = await services.api.client.POST(
                  "/api/v1/admin/auth/confirm-totp",
                  { body: { ticket: enrollment.data.ticket, code } },
                );
                if (!data) throw new Error(await failureText(response));
                setConfirmed(data.data);
                services.api.resetLoginLatch();
              });
            }}
          >
            <FormField label="6 位动态口令" value={code} maxLength={6}>
              {(props) => (
                <Input
                  {...props}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  disabled={submit.pending}
                  maxLength={6}
                  required
                  pattern="[0-9]{6}"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              )}
            </FormField>
            <ErrorMessage error={submit.error} />
            <Button type="primary" htmlType="submit" block loading={submit.pending}>
              验证并绑定
            </Button>
          </form>
        </>
      ) : (
        <>
          <ErrorMessage error={enrollment.error?.message} />
          <Button onClick={() => void enrollment.refetch()}>重试</Button>
        </>
      )}
      <Button
        type="link"
        className="lyx-auth-link"
        disabled={submit.pending}
        onClick={() => {
          authTicket.set(null);
          services.queryClient.removeQueries({ queryKey: ["auth", "enroll"] });
          go("/login");
        }}
      >
        返回登录
      </Button>
    </AuthCard>
  );
}
export function StepUpModal({ services }: { services: AppServices }) {
  const open = useSyncExternalStore(
    services.stepUp.subscribe,
    services.stepUp.get,
    services.stepUp.get,
  );
  return open ? <StepUpForm services={services} /> : null;
}
function StepUpForm({ services }: { services: AppServices }) {
  const [method, setMethod] = useState<"totp" | "recovery">("totp");
  const [code, setCode] = useState("");
  const submit = useSubmit();
  return (
    <Modal
      title="验证身份后继续"
      open
      centered
      closable={!submit.pending}
      mask={{ closable: !submit.pending }}
      keyboard={!submit.pending}
      onCancel={() => services.stepUp.settle(false)}
      footer={null}
      destroyOnHidden
    >
      <p>本次操作需要再次验证动态口令或恢复码。</p>
      <form
        aria-label="再次验证身份"
        className="lyx-auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit.run(async () => {
            const { data, response } = await services.api.client.POST(
              "/api/v1/admin/auth/step-up",
              { body: { method, code } },
            );
            if (!data) throw new Error(await failureText(response));
            services.stepUp.settle(true);
          });
        }}
      >
        <FactorField {...{ method, setMethod, code, setCode }} pending={submit.pending} />
        <ErrorMessage error={submit.error} />
        <div className="lyx-auth-modal-actions">
          <Button disabled={submit.pending} onClick={() => services.stepUp.settle(false)}>
            取消
          </Button>
          <Button type="primary" htmlType="submit" loading={submit.pending}>
            验证并继续
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function UserMenu({ services, access }: { services: AppServices; access: AccessSnapshot }) {
  return <UserMenuBody key={actorScope(access)} services={services} access={access} />;
}
function UserMenuBody({ services, access }: { services: AppServices; access: AccessSnapshot }) {
  const router = useRouter();
  const submit = useSubmit();
  const [security, setSecurity] = useState<SecurityMode>();
  useEffect(() => {
    if (submit.error)
      showApiNotice({ symbol: "NETWORK_ERROR", message: submit.error, requestIdTail: null });
  }, [submit.error]);
  return (
    <>
      <Dropdown
        trigger={["click"]}
        menu={{
          items: securityMenuItems(access.actions, submit.pending),
          onClick: ({ key }) => {
            if (key === "password" || key === "totp" || key === "wecom") {
              setSecurity(key);
              return;
            }
            setSecurity(undefined);
            void submit.run(async () => {
              const { response } = await services.api.client.DELETE(
                "/api/v1/admin/sessions/current",
              );
              if (!response.ok) throw new Error(await failureText(response));
              services.stepUp.settle(false);
              authTicket.set(null);
              services.api.resetLoginLatch();
              // 等登录页提交、原页查询观察者卸载后清缓存，避免已退出的页面重新取数。
              await router.navigate({
                to: "/login",
                search: { redirect: undefined },
                replace: true,
              });
              services.queryClient.clear();
            });
          },
        }}
      >
        <button
          type="button"
          className="lyx-auth-user lyx-focusable"
          aria-label="用户菜单"
          disabled={submit.pending}
        >
          <span className="lyx-user__avatar" aria-hidden="true">
            {access.staff.name.slice(0, 1)}
          </span>
          <span>
            <span className="lyx-user__name">{access.staff.name}</span>
            <span className="lyx-user__role">{access.staff.roleName}</span>
          </span>
          <span aria-hidden="true">⌄</span>
        </button>
      </Dropdown>
      {security ? (
        <SecurityDialog
          key={security}
          mode={security}
          services={services}
          close={() => setSecurity(undefined)}
        />
      ) : null}
    </>
  );
}
