import { expect, type Locator, type Page } from "@playwright/test";
import { DramaTrailerBodySchema, DramaTrailerWriteResultSchema } from "@liyoxi/contract";

type TrailerWrite = { key: string; body?: unknown; read: boolean; forwarded: number };
declare global {
  interface Window {
    __w312TrailerCapture?: {
      writes: TrailerWrite[];
      errors: string[];
      restore(): void;
    };
  }
}

/** Only validated CHECKING responses may account for this case's exact 409 console records. */
export function recordTrailerErrors(page: Page, path: string) {
  const errors: { message: string; url?: string }[] = [];
  page.on("pageerror", (error) => errors.push({ message: error.message }));
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push({ message: message.text(), url: message.location().url });
  });
  return {
    unexpected(checking: number) {
      let matches = 0;
      const remaining = errors.filter((error) => {
        const expected =
          error.url === new URL(path, page.url()).toString() &&
          error.message ===
            "Failed to load resource: the server responded with a status of 409 (Conflict)";
        if (expected) matches++;
        return !expected;
      });
      expect(matches, "Each allowed console error needs one validated CHECKING response").toBe(
        checking,
      );
      return remaining.map((error) => error.message);
    },
  };
}

/** Observe original streamed requests without replacing any request, response or Promise. */
export async function saveTrailerDialog(page: Page, dialog: Locator, path: string) {
  await page.evaluate((target) => {
    const original = window.fetch;
    const writes: TrailerWrite[] = [],
      errors: string[] = [];
    const state = {
      writes,
      errors,
      restore: () => {
        window.fetch = original;
        delete window.__w312TrailerCapture;
      },
    };
    window.__w312TrailerCapture = state;
    window.fetch = function (this: Window, input, init) {
      let write: TrailerWrite | undefined;
      if (
        input instanceof Request &&
        input.method === "PUT" &&
        new URL(input.url).origin === location.origin &&
        new URL(input.url).pathname === target
      ) {
        write = { key: input.headers.get("Idempotency-Key") ?? "", read: false, forwarded: 0 };
        state.writes.push(write);
        if (init !== undefined || !write.key)
          state.errors.push("Unexpected override or missing key");
        const record = write;
        try {
          void input
            .clone()
            .json()
            .then(
              (body: unknown) => {
                record.body = body;
                record.read = true;
              },
              () => state.errors.push("Trailer request clone JSON failed"),
            );
        } catch {
          state.errors.push("Trailer request clone failed");
        }
      }
      // Exactly one native call, with the original arguments and unchanged return Promise.
      const result = original.call(this, input, init);
      if (write) write.forwarded++;
      return result;
    };
  }, path);
  const keys: string[] = [],
    checkingSources: string[] = [];
  try {
    const waiting = page.waitForResponse(async (response) => {
      if (
        response.request().method() !== "PUT" ||
        response.url() !== new URL(path, page.url()).toString()
      )
        return false;
      const key = response.request().headers()["idempotency-key"];
      expect(key).toBeTruthy();
      if (!key) throw new Error("Trailer response has no idempotency key");
      keys.push(key);
      if (response.status() === 200) return true;
      expect(response.status()).toBe(409);
      const body: unknown = await response.json();
      expect(body).toMatchObject({
        code: 49218,
        error: "TRAILER_SOURCE_CHECKING",
        retryable: true,
      });
      const details =
        typeof body === "object" && body !== null ? Reflect.get(body, "details") : null;
      const source =
        typeof details === "object" && details !== null
          ? Reflect.get(details, "sourceFileId")
          : null;
      expect(typeof source).toBe("string");
      if (typeof source !== "string") throw new Error("CHECKING has no source file identity");
      checkingSources.push(source);
      return false;
    });
    await dialog.getByRole("button", { name: "设置并转换", exact: true }).click();
    const response = await waiting;
    const result = DramaTrailerWriteResultSchema.parse((await response.json()).data);
    await expect(dialog).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.__w312TrailerCapture;
          return !!state && state.writes.length > 0 && state.writes.every((write) => write.read);
        }),
      )
      .toBe(true);
    const capture = await page.evaluate(() => ({
      writes: window.__w312TrailerCapture?.writes,
      errors: window.__w312TrailerCapture?.errors,
    }));
    expect(capture.errors).toEqual([]);
    if (!capture.writes) throw new Error("Trailer request observation is missing");
    expect(capture.writes).toHaveLength(keys.length);
    expect(keys.length).toBe(checkingSources.length + 1);
    expect(keys.every((value) => value === keys[0])).toBe(true);
    expect(checkingSources.every((value) => value === result.sourceFile.fileId)).toBe(true);
    for (const write of capture.writes) {
      expect(write.read).toBe(true);
      expect(write.forwarded).toBe(1);
      expect(write.key).toBe(keys[0]);
      expect(DramaTrailerBodySchema.parse(write.body)).toEqual({
        sourceFileId: result.sourceFile.fileId,
      });
    }
    return checkingSources.length;
  } finally {
    await page.evaluate(() => window.__w312TrailerCapture?.restore());
  }
}
