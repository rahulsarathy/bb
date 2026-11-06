import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "@bb/test-helpers";
import { describe, expect, it } from "vitest";
import {
  discardSupersededServerMovedFile,
  LAST_SERVER_MOVE_FILE_NAME,
  readLastServerMoveFile,
  readServerConnectHoldFile,
  readServerImportFile,
  readServerMovedFile,
  removeServerConnectHoldFile,
  SERVER_CONNECT_HOLD_FILE_NAME,
  SERVER_IMPORT_FILE_NAME,
  SERVER_MOVED_FILE_NAME,
  type ServerConnectHoldFile,
  type ServerImportFile,
  type ServerMovedFile,
  writeLastServerMoveFile,
  writeServerConnectHoldFile,
  writeServerImportFile,
  writeServerMovedFile,
} from "../src/index.js";

const MOVED_FILE: ServerMovedFile = {
  version: 1,
  moveId: "move-1",
  movedAt: 1_757_000_000_000,
  fromHostId: "host-old",
  toHostId: "host-new",
  toHostName: "desktop",
  serverUrl: "https://bb.example",
  mode: "connect",
  connectHandle: "sawyer",
  oldCopyEntries: ["bb.db", "attachments", "plugins/docs/data.db"],
};

const IMPORT_FILE: ServerImportFile = {
  version: 1,
  kind: "move",
  moveId: "move-1",
  activationToken: "activation-token-0123456789",
  sourceDataDir: "/home/old/.bb",
  sourceServerHostId: "host-old",
  targetHostId: "host-new",
  serverUrl: null,
  importedEntries: ["bb.db", "config.json"],
  createdAt: 1_757_000_000_000,
  fixupsAppliedAt: null,
};

describe("server move marker files", () => {
  it("returns null for absent markers and round trips each marker with mode 0600", async () => {
    const dataDir = await makeTempDir();
    expect(await readServerMovedFile(dataDir)).toBeNull();
    expect(await readServerImportFile(dataDir)).toBeNull();
    expect(await readLastServerMoveFile(dataDir)).toBeNull();

    const lastMove = {
      version: 1 as const,
      moveId: "move-1",
      fromHostId: "host-old",
      fromHostName: "laptop",
      toHostId: "host-new",
      toHostName: "desktop",
      completedAt: 1_757_000_000_000,
      oldCopyDeletedAt: null,
    };
    await writeServerMovedFile(dataDir, MOVED_FILE);
    await writeServerImportFile(dataDir, IMPORT_FILE);
    await writeLastServerMoveFile(dataDir, lastMove);

    expect(await readServerMovedFile(dataDir)).toEqual(MOVED_FILE);
    expect(await readServerImportFile(dataDir)).toEqual(IMPORT_FILE);
    expect(await readLastServerMoveFile(dataDir)).toEqual(lastMove);
    expect((await readdir(dataDir)).sort()).toEqual(
      [
        LAST_SERVER_MOVE_FILE_NAME,
        SERVER_IMPORT_FILE_NAME,
        SERVER_MOVED_FILE_NAME,
      ].sort(),
    );
    for (const fileName of await readdir(dataDir)) {
      if (process.platform !== "win32") {
        expect((await stat(path.join(dataDir, fileName))).mode & 0o777).toBe(
          0o600,
        );
      }
    }
  });

  it("round trips the bb connect hold with mode 0600 and removes it once", async () => {
    const dataDir = await makeTempDir();
    expect(SERVER_CONNECT_HOLD_FILE_NAME).toBe("server-connect-hold.json");
    expect(await readServerConnectHoldFile(dataDir)).toBeNull();
    expect(await removeServerConnectHoldFile(dataDir)).toBe(false);

    const hold: ServerConnectHoldFile = {
      version: 1,
      reason: "manual-import",
      createdAt: 1_757_000_000_000,
    };
    await writeServerConnectHoldFile(dataDir, hold);

    expect(await readServerConnectHoldFile(dataDir)).toEqual(hold);
    if (process.platform !== "win32") {
      expect(
        (await stat(path.join(dataDir, SERVER_CONNECT_HOLD_FILE_NAME))).mode &
          0o777,
      ).toBe(0o600);
    }

    await writeFile(
      path.join(dataDir, SERVER_CONNECT_HOLD_FILE_NAME),
      JSON.stringify({ ...hold, reason: "move" }),
    );
    await expect(readServerConnectHoldFile(dataDir)).rejects.toThrow(
      /Invalid/u,
    );

    expect(await removeServerConnectHoldFile(dataDir)).toBe(true);
    expect(await removeServerConnectHoldFile(dataDir)).toBe(false);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("throws on invalid JSON and on markers that fail the schema", async () => {
    const dataDir = await makeTempDir();
    await writeFile(path.join(dataDir, SERVER_MOVED_FILE_NAME), "{ not json");
    await expect(readServerMovedFile(dataDir)).rejects.toThrow(/Invalid JSON/u);

    await writeFile(
      path.join(dataDir, SERVER_IMPORT_FILE_NAME),
      JSON.stringify({ ...IMPORT_FILE, extra: true }),
    );
    await expect(readServerImportFile(dataDir)).rejects.toThrow(/Invalid/u);
  });

  it("refuses to write markers that could target paths outside the data directory", async () => {
    const dataDir = await makeTempDir();
    for (const oldCopyEntry of ["../.ssh", "auth.json", "plugins/docs"]) {
      await expect(
        writeServerMovedFile(dataDir, {
          ...MOVED_FILE,
          oldCopyEntries: [oldCopyEntry],
        }),
      ).rejects.toThrow(/server-owned/u);
    }
    for (const importedEntry of ["/etc/passwd", "host-id", "npm/lib/x"]) {
      await expect(
        writeServerImportFile(dataDir, {
          ...IMPORT_FILE,
          importedEntries: [importedEntry],
        }),
      ).rejects.toThrow(/server-owned/u);
    }
    await expect(
      writeServerImportFile(dataDir, {
        ...IMPORT_FILE,
        activationToken: null,
      }),
    ).rejects.toThrow(/activationToken/u);
    expect(await readdir(dataDir)).toEqual([]);
  });
});

describe("discardSupersededServerMovedFile", () => {
  const movedAway: ServerMovedFile = {
    ...MOVED_FILE,
    oldCopyEntries: [],
  };
  const movedBack = {
    version: 1 as const,
    moveId: "move-2",
    fromHostId: "host-new",
    fromHostName: "desktop",
    toHostId: "host-old",
    toHostName: "laptop",
    completedAt: movedAway.movedAt + 60_000,
    oldCopyDeletedAt: null,
  };

  it("removes a marker left by an earlier move once the server moved back here", async () => {
    const dataDir = await makeTempDir();
    await writeServerMovedFile(dataDir, movedAway);
    await writeLastServerMoveFile(dataDir, movedBack);

    expect(await discardSupersededServerMovedFile(dataDir)).toEqual(movedAway);
    expect(await readServerMovedFile(dataDir)).toBeNull();
    expect(await readLastServerMoveFile(dataDir)).toEqual(movedBack);
  });

  it.each([
    {
      name: "the last move is the one that wrote the marker",
      lastMove: {
        ...movedBack,
        moveId: movedAway.moveId,
        fromHostId: movedAway.fromHostId,
        toHostId: movedAway.toHostId,
        completedAt: movedAway.movedAt,
      },
    },
    {
      name: "the last move went to another machine",
      lastMove: { ...movedBack, toHostId: "host-third" },
    },
    {
      name: "the last move finished before the marker was written",
      lastMove: { ...movedBack, completedAt: movedAway.movedAt - 1 },
    },
    { name: "there is no last move", lastMove: null },
  ])("keeps the marker when $name", async ({ lastMove }) => {
    const dataDir = await makeTempDir();
    await writeServerMovedFile(dataDir, movedAway);
    if (lastMove !== null) {
      await writeLastServerMoveFile(dataDir, lastMove);
    }

    expect(await discardSupersededServerMovedFile(dataDir)).toBeNull();
    expect(await readServerMovedFile(dataDir)).toEqual(movedAway);
  });

  it("keeps the marker when last-server-move.json is unreadable", async () => {
    const dataDir = await makeTempDir();
    await writeServerMovedFile(dataDir, movedAway);
    await writeFile(path.join(dataDir, LAST_SERVER_MOVE_FILE_NAME), "{");

    expect(await discardSupersededServerMovedFile(dataDir)).toBeNull();
    expect(await readServerMovedFile(dataDir)).toEqual(movedAway);
  });
});
