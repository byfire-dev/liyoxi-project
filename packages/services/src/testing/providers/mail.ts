// 假邮件：不发，只放进发件箱。

import { ok } from "../../providers/types.js";
import type { MailAttachment, MailProvider, ProviderMethodName } from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<MailProvider>;

export interface FakeMailMessage {
  messageId: string;
  to: string;
  subject: string;
  text: string;
  attachments: MailAttachment[];
}

export interface FakeMail extends MailProvider, FakeControl<Method> {
  /** “发出去”的邮件，按先后 */
  readonly outbox: FakeMailMessage[];
}

export function createFakeMail(options: { clock?: FakeClock } = {}): FakeMail {
  const core = createFakeCore<Method>(options.clock ?? systemClock);
  const outbox: FakeMailMessage[] = [];

  return {
    status: "fake",
    configured: true,
    ...core.control,
    outbox,

    send: (input) =>
      core.run("send", input, () => {
        const messageId = `fake-mail-${outbox.length + 1}`;
        outbox.push({ messageId, ...input, attachments: [...(input.attachments ?? [])] });
        return ok({ messageId });
      }),
  };
}
