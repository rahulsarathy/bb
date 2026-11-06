import { eq, inArray, sql } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";
import { events, threadPurges } from "../schema.js";

const THREAD_PURGE_BATCHED_TABLES = [
  "thread_search_segments",
  "prompt_history_entries",
  "project_attachment_threads",
] as const;

export function requestThreadPurge(
  db: DbQueryConnection,
  args: { now: number; threadId: string },
): void {
  db.insert(threadPurges)
    .values({ requestedAt: args.now, retryAt: args.now, threadId: args.threadId })
    .onConflictDoNothing()
    .run();
}

export function nextThreadPurge(
  db: DbQueryConnection,
  args: { now: number },
): string | null {
  return (
    db.get<{ threadId: string }>(sql`
      SELECT p.thread_id AS threadId FROM thread_purges p
      WHERE p.retry_at <= ${args.now}
        AND NOT EXISTS (
          SELECT 1 FROM threads c WHERE c.lifecycle_owner_thread_id = p.thread_id
        )
      ORDER BY p.requested_at, p.thread_id
      LIMIT 1
    `)?.threadId ?? null
  );
}

export function recordThreadPurgeFailure(
  db: DbQueryConnection,
  args: {
    error: string;
    retryDelayMs: (attempts: number) => number;
    now: number;
    threadId: string;
  },
): number {
  const attempts =
    (db
      .select({ attempts: threadPurges.attempts })
      .from(threadPurges)
      .where(eq(threadPurges.threadId, args.threadId))
      .get()?.attempts ?? 0) + 1;
  db.update(threadPurges)
    .set({
      attempts,
      lastError: args.error,
      retryAt: args.now + args.retryDelayMs(attempts),
    })
    .where(eq(threadPurges.threadId, args.threadId))
    .run();
  return attempts;
}

export function deleteThreadPurgeBatch(
  db: DbQueryConnection,
  args: {
    maxEventBytes: number;
    maxEventRows: number;
    maxRows: number;
    threadId: string;
  },
): number {
  const candidates = db.all<{ bytes: number; id: string }>(sql`
    SELECT id, octet_length(data) AS bytes FROM events
    WHERE thread_id = ${args.threadId}
    ORDER BY sequence
    LIMIT ${args.maxEventRows}
  `);
  const eventIds: string[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (eventIds.length > 0 && bytes + candidate.bytes > args.maxEventBytes) break;
    eventIds.push(candidate.id);
    bytes += candidate.bytes;
  }
  if (eventIds.length > 0) {
    return db.delete(events).where(inArray(events.id, eventIds)).run().changes;
  }
  for (const table of THREAD_PURGE_BATCHED_TABLES) {
    const deleted = db.run(sql`
      DELETE FROM ${sql.identifier(table)} WHERE rowid IN (
        SELECT rowid FROM ${sql.identifier(table)}
        WHERE thread_id = ${args.threadId}
        LIMIT ${args.maxRows}
      )
    `).changes;
    if (deleted > 0) return deleted;
  }
  return 0;
}
