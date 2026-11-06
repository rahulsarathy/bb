import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getThread, threadPurges } from "@bb/db";
import { threadScope } from "@bb/domain";
import {
  advanceThreadPurge,
  startThreadPurging,
} from "../../src/services/threads/thread-purge.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
} from "../helpers/seed.js";
import { type TestAppHarness, withTestHarness } from "../helpers/test-app.js";

const API = "/api/v1";

function seedThreadWithEvents(harness: TestAppHarness, count: number) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const thread = seedThread(harness.deps, { projectId: project.id });
  for (let sequence = 1; sequence <= count; sequence++) {
    seedStoredEvent(harness.deps, {
      data: { text: `event ${sequence}` },
      scope: threadScope(),
      sequence,
      threadId: thread.id,
      type: "thread/identity",
    });
  }
  return thread;
}

function countEvents(harness: TestAppHarness, threadId: string): number {
  return (
    harness.db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM events WHERE thread_id = ${threadId}`,
    )?.count ?? 0
  );
}

function deleteThreadRequest(harness: TestAppHarness, threadId: string) {
  return harness.app.request(`${API}/threads/${threadId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ childThreadsConfirmed: false }),
  });
}

describe("paced thread deletion", () => {
  it("keeps a deleted thread hidden while its rows are deleted in batches", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedThreadWithEvents(harness, 200);

      expect((await deleteThreadRequest(harness, thread.id)).status).toBe(200);
      expect(getThread(harness.db, thread.id)?.deletedAt).toEqual(expect.any(Number));
      expect(countEvents(harness, thread.id)).toBe(200);

      expect(advanceThreadPurge(harness.deps, Date.now())).toBe(true);
      expect(countEvents(harness, thread.id)).toBe(136);
      expect(
        (await harness.app.request(`${API}/threads/${thread.id}`)).status,
      ).toBe(404);

      while (advanceThreadPurge(harness.deps, Date.now())) {}
      expect(getThread(harness.db, thread.id)).toBeNull();
      expect(countEvents(harness, thread.id)).toBe(0);
    });
  });

  it("starts deleting as soon as a thread is deleted instead of waiting for the next poll", async () => {
    await withTestHarness(async (harness) => {
      const purging = startThreadPurging(harness.deps, { isFrozen: () => false });
      try {
        const thread = seedThreadWithEvents(harness, 500);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect((await deleteThreadRequest(harness, thread.id)).status).toBe(200);

        await vi.waitFor(() => expect(getThread(harness.db, thread.id)).toBeNull(), {
          timeout: 5_000,
        });
        expect(countEvents(harness, thread.id)).toBe(0);
      } finally {
        purging.stop();
      }
    });
  });

  it("moves past a thread whose purge keeps failing and retries it after a delay", async () => {
    await withTestHarness(async (harness) => {
      const failing = seedThreadWithEvents(harness, 3);
      const next = seedThreadWithEvents(harness, 3);
      harness.db.run(
        sql.raw(
          `CREATE TEMP TRIGGER fail_purge BEFORE DELETE ON events WHEN old.thread_id = '${failing.id}' BEGIN SELECT RAISE(ABORT, 'simulated purge failure'); END`,
        ),
      );
      expect((await deleteThreadRequest(harness, failing.id)).status).toBe(200);
      expect((await deleteThreadRequest(harness, next.id)).status).toBe(200);
      const now = Date.now();

      while (advanceThreadPurge(harness.deps, now)) {}
      expect(getThread(harness.db, next.id)).toBeNull();
      expect(countEvents(harness, failing.id)).toBe(3);
      expect(
        harness.db
          .select()
          .from(threadPurges)
          .where(eq(threadPurges.threadId, failing.id))
          .get(),
      ).toMatchObject({
        attempts: 1,
        lastError: expect.stringContaining("simulated purge failure"),
        retryAt: now + 60_000,
      });
      expect(advanceThreadPurge(harness.deps, now + 59_999)).toBe(false);

      harness.db.run(sql`DROP TRIGGER fail_purge`);
      while (advanceThreadPurge(harness.deps, now + 60_000)) {}
      expect(getThread(harness.db, failing.id)).toBeNull();
    });
  });
});
