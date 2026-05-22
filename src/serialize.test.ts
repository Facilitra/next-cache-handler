import { describe, it, expect } from "vitest";
import { serializeEntry, deserializeEntry } from "./serialize.js";
import type { CacheEntry } from "./types.js";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function erroringStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.error(new Error("boom"));
    },
  });
}

function entryWith(value: ReadableStream<Uint8Array>): CacheEntry {
  return {
    value,
    tags: ["t1", "t2"],
    stale: 5,
    timestamp: 1_700_000_000_000,
    expire: 120,
    revalidate: 60,
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe("serialize round-trip", () => {
  it("serialize then deserialize yields the same bytes", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 128, 64, 255]);
    const entry = entryWith(streamFromChunks([bytes.slice(0, 3), bytes.slice(3)]));

    const stored = await serializeEntry(entry);
    expect(stored).not.toBeNull();

    const rebuilt = deserializeEntry(stored!);
    const out = await readAll(rebuilt.value);

    expect(Array.from(out)).toEqual(Array.from(bytes));
  });

  it("preserves all metadata fields", async () => {
    const entry = entryWith(streamFromChunks([new Uint8Array([9])]));
    const stored = await serializeEntry(entry);
    expect(stored).not.toBeNull();
    expect(stored).toMatchObject({
      tags: ["t1", "t2"],
      stale: 5,
      timestamp: 1_700_000_000_000,
      expire: 120,
      revalidate: 60,
    });
    const rebuilt = deserializeEntry(stored!);
    expect(rebuilt).toMatchObject({
      tags: ["t1", "t2"],
      stale: 5,
      timestamp: 1_700_000_000_000,
      expire: 120,
      revalidate: 60,
    });
  });

  it("round-trips an empty stream", async () => {
    const entry = entryWith(streamFromChunks([]));
    const stored = await serializeEntry(entry);
    expect(stored).not.toBeNull();
    const out = await readAll(deserializeEntry(stored!).value);
    expect(out.length).toBe(0);
  });

  it("returns null for an errored/aborted stream", async () => {
    const entry = entryWith(erroringStream());
    const stored = await serializeEntry(entry);
    expect(stored).toBeNull();
  });
});
