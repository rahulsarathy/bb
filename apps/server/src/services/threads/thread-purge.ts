import {
  deleteThread,
  deleteThreadPurgeBatch,
  listRunningThreads,
  nextThreadPurge,
  recordThreadPurgeFailure,
} from "@bb/db";
import type { AppDeps } from "../../types.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";

const THREAD_PURGE_SLICE_MS = 10;
const BUSY_REST_FACTOR = 9;
const IDLE_REST_FACTOR = 1;
const IDLE_POLL_MS = 60_000;
const PURGE_EVENT_ROWS = 64;
const PURGE_EVENT_BYTES = 512 * 1024;
const PURGE_ROWS = 128;
const STEP_COST_SMOOTHING = 0.2;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const REPEATED_FAILURE_ATTEMPTS = 5;

type ThreadPurgeDeps = Pick<AppDeps, "db" | "hub" | "logger">;

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 16));
}

export function advanceThreadPurge(deps: ThreadPurgeDeps, now: number): boolean {
  const threadId = nextThreadPurge(deps.db, { now });
  if (threadId === null) return false;
  const notifications = new NotificationBuffer();
  try {
    deps.db.transaction(
      (tx) => {
        const deleted = deleteThreadPurgeBatch(tx, {
          maxEventBytes: PURGE_EVENT_BYTES,
          maxEventRows: PURGE_EVENT_ROWS,
          maxRows: PURGE_ROWS,
          threadId,
        });
        if (deleted === 0) deleteThread(tx, notifications, threadId);
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    const attempts = recordThreadPurgeFailure(deps.db, {
      error: error instanceof Error ? error.message : String(error),
      now,
      retryDelayMs,
      threadId,
    });
    const log = { attempts, err: error, retryInMs: retryDelayMs(attempts), threadId };
    if (attempts >= REPEATED_FAILURE_ATTEMPTS) {
      deps.logger.error(log, "Thread purge keeps failing; other threads continue");
    } else {
      deps.logger.warn(log, "Thread purge step failed; retrying later");
    }
    return true;
  }
  notifications.flushInto(deps.hub);
  return true;
}

const wakers = new Set<() => void>();

export function wakeThreadPurging(): void {
  for (const wake of wakers) wake();
}

export function startThreadPurging(
  deps: ThreadPurgeDeps,
  options: { isFrozen(): boolean },
): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let stepCostMs = 0;
  let resting = false;

  const schedule = (delayMs: number, afterWork: boolean) => {
    if (stopped) return;
    resting = afterWork;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(tick, delayMs);
    timer.unref();
  };

  function tick(): void {
    timer = null;
    if (stopped) return;
    if (options.isFrozen()) {
      schedule(IDLE_POLL_MS, false);
      return;
    }
    const startedAt = performance.now();
    let idle = false;
    try {
      do {
        const stepStartedAt = performance.now();
        idle = !advanceThreadPurge(deps, Date.now());
        stepCostMs += STEP_COST_SMOOTHING * (performance.now() - stepStartedAt - stepCostMs);
      } while (
        !idle &&
        !stopped &&
        performance.now() - startedAt + stepCostMs <= THREAD_PURGE_SLICE_MS
      );
    } catch (error) {
      deps.logger.warn({ err: error }, "Thread purge step failed");
      schedule(IDLE_POLL_MS, false);
      return;
    }
    if (idle) {
      schedule(IDLE_POLL_MS, false);
      return;
    }
    const busy = deps.hub.hasClients() || listRunningThreads(deps.db).length > 0;
    const worked = performance.now() - startedAt;
    schedule(Math.max(1, worked * (busy ? BUSY_REST_FACTOR : IDLE_REST_FACTOR)), true);
  }

  const wake = () => {
    if (!resting) schedule(0, false);
  };
  wakers.add(wake);
  schedule(0, false);
  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      wakers.delete(wake);
    },
  };
}
