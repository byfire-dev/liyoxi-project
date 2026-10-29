import { useEffect, useMemo, useRef, useState } from "react";
import { ReconFailure, reconConflict, reconError } from "./api";
import { createReconcileIntent } from "./model";
import type { ReconCommand } from "./types";

/** 本域提交/重读生命周期；成功后读取失败只能重读，不再次POST。 */
export function useReconcileMutation<B, T>({
  command,
  execute,
  refresh,
  onDone,
  invalidate,
}: {
  command: ReconCommand;
  execute: (body: B, key: string, signal: AbortSignal) => Promise<T>;
  refresh: (signal: AbortSignal, result?: T) => Promise<void>;
  onDone: (result: T) => void;
  invalidate: () => void;
}) {
  const intent = useMemo(() => createReconcileIntent(), []),
    alive = useRef(true),
    reader = useRef<AbortController | undefined>(undefined),
    committed = useRef<{ result: T } | undefined>(undefined),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [notice, setNotice] = useState<string>(),
    [conflicts, setConflicts] = useState<ReconFailure["conflicts"]>([]),
    [readOnly, setReadOnly] = useState(false);
  useEffect(() => {
    alive.current = true;
    intent.activate();
    return () => {
      alive.current = false;
      intent.close();
      reader.current?.abort();
    };
  }, [intent]);
  async function reread() {
    if (busy || intent.pending || reader.current) return;
    const controller = new AbortController();
    reader.current = controller;
    setBusy(true);
    try {
      await refresh(controller.signal, committed.current?.result);
      controller.signal.throwIfAborted();
      if (alive.current) {
        setBlocked(false);
        setNotice(undefined);
        setConflicts([]);
        invalidate();
        if (committed.current) onDone(committed.current.result);
      }
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setNotice(reconError(error));
    } finally {
      if (reader.current === controller) reader.current = undefined;
      if (alive.current) setBusy(false);
    }
  }
  async function submit(body: B) {
    if (busy || intent.pending || blocked || committed.current) return;
    setBusy(true);
    setNotice(undefined);
    setConflicts([]);
    try {
      await intent.submit(command, body, async (key, signal) => {
        let value: T;
        try {
          value = await execute(body, key, signal);
        } catch (error) {
          if (reconConflict(error) && alive.current && !signal.aborted) {
            setBlocked(true);
            invalidate();
            try {
              await refresh(signal);
              if (alive.current && !signal.aborted) setBlocked(false);
            } catch {
              /* 未读回保持停写。 */
            }
          }
          throw error;
        }
        if (!alive.current || signal.aborted) return;
        committed.current = { result: value };
        setReadOnly(true);
        setBlocked(true);
        invalidate();
        try {
          await refresh(signal, value);
          signal.throwIfAborted();
          if (alive.current) onDone(value);
        } catch {
          if (alive.current && !signal.aborted)
            setNotice("操作已提交成功，读取失败；请重新读取，不要重复提交");
        }
      });
    } catch (error) {
      if (alive.current) {
        setNotice(reconError(error));
        if (error instanceof ReconFailure) setConflicts(error.conflicts);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return { busy, blocked, notice, conflicts, readOnly, pending: intent.pending, submit, reread };
}
