import { describe, expect, it } from "vitest";
import sink from "./performance/parity-tail.js";

describe("native benchmark Tail sink", () => {
  it("persists only correlated diagnostics and native timing, without request credentials or unrelated logs", async () => {
    const writes: { key: string; value: unknown }[] = [];
    const id = "00000000-0000-4000-8000-000000000812";
    const message = ["mantle-benchmark-v1", JSON.stringify({ id, observation: {
      record: { version: 1, d1: { statements: 3 } }, bootId: "boot", colo: "TPE", country: "TW", placement: "remote-NRT",
      ignoredSecret: "never-store-this",
    } })];
    const event = { scriptName: "mantle-parity-812", cpuTime: 0, wallTime: 8, outcome: "ok", eventTimestamp: 123,
      scriptVersion: { id: "version" }, truncated: false,
      event: { request: { headers: { authorization: "Bearer never-store-this" }, url: "https://example.test/?secret=never-store-this" } },
      exceptions: [{ message: "never-store-this" }], logs: [{ message }, { message: ["unrelated", "never-store-this"] }] } as unknown as TraceItem;
    const database = (save: (id: string, value: string) => void) => ({
      prepare: () => ({ bind: (id: string, value: string) => ({ id, value }) }),
      batch: async (batch: { id: string; value: string }[]) => { for (const { id, value } of batch) save(id, value); },
    }) as unknown as D1Database;
    await sink.tail([event, { ...event, scriptName: "other-worker" }], {
      DB: database((id, value) => { writes.push({ key: id, value: JSON.parse(value) }); }),
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ key: id, value: { record: { version: 1 }, placement: "remote-NRT",
      platform: { cpuTimeMs: 0, wallTimeMs: 8, outcome: "ok", scriptVersion: "version", source: "Cloudflare Tail invocation" } } });
    expect(JSON.stringify(writes)).not.toContain("never-store-this");
    await sink.tail([{ ...event, cpuTime: undefined, wallTime: undefined } as unknown as TraceItem], {
      DB: database((_key, value) => {
        expect(JSON.parse(value).platform).toMatchObject({ cpuTimeMs: null, wallTimeMs: null });
      }),
    });
    await expect(sink.tail([event], { DB: database(() => { throw new Error("storage failed"); }) }))
      .rejects.toThrow("storage failed");
  });
});
