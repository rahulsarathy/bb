import type { AppDeps } from "../../src/types.js";
import { advanceThreadPurge } from "../../src/services/threads/thread-purge.js";

export function runThreadPurges(deps: Pick<AppDeps, "db" | "hub" | "logger">): void {
  while (advanceThreadPurge(deps, Date.now())) {}
}
