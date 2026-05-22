/**
 * Drain a (possibly still-pending, possibly erroring) stream into a Buffer.
 * Returns null if the stream errored, so the caller can choose NOT to cache a
 * partial/corrupt payload. Next explicitly warns these streams can error.
 */
async function drainStream(stream) {
    const reader = stream.getReader();
    const chunks = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value)
                chunks.push(value);
        }
    }
    catch {
        return null;
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}
/**
 * Serialize a resolved CacheEntry to the wire shape. Returns null if the value
 * stream errored mid-flight (do not cache partial data).
 */
export async function serializeEntry(entry) {
    const buf = await drainStream(entry.value);
    if (buf === null)
        return null;
    return {
        value: buf.toString("base64"),
        tags: entry.tags,
        stale: entry.stale,
        timestamp: entry.timestamp,
        expire: entry.expire,
        revalidate: entry.revalidate,
    };
}
/** Rebuild a fresh CacheEntry (with a new readable stream) from stored bytes. */
export function deserializeEntry(stored) {
    const bytes = Buffer.from(stored.value, "base64");
    return {
        value: new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(bytes));
                controller.close();
            },
        }),
        tags: stored.tags,
        stale: stored.stale,
        timestamp: stored.timestamp,
        expire: stored.expire,
        revalidate: stored.revalidate,
    };
}
