/** Synthetic benchmark sink. Never stores request headers, bodies or exceptions. */
export default {
  async tail(events: TraceItem[], env: { MEDIA: R2Bucket; BENCH_SCRIPT?: string }) {
    const writes: { id: string; value: string }[] = [];
    for (const event of events) {
      if (event.scriptName !== (env.BENCH_SCRIPT ?? "mantle-parity-812")) continue;
      for (const log of event.logs) {
        if (!Array.isArray(log.message) || log.message[0] !== "mantle-benchmark-v1" || typeof log.message[1] !== "string") continue;
        let data;
        try { data = JSON.parse(log.message[1]); } catch { continue; }
        if (!data || !/^[a-f0-9-]{36}$/i.test(data.id) || !data.observation) continue;
        const { record, bootId, colo, country, placement } = data.observation;
        writes.push({ id: data.id, value: JSON.stringify({ record: record ?? null, bootId, colo, country, placement,
          platform: { source: "Cloudflare Tail invocation", cpuTimeMs: Number.isFinite(event.cpuTime) ? event.cpuTime : null,
            wallTimeMs: Number.isFinite(event.wallTime) ? event.wallTime : null,
            outcome: event.outcome, timestamp: event.eventTimestamp, scriptVersion: event.scriptVersion?.id ?? null, truncated: event.truncated } }) });
      }
    }
    for (let offset = 0; offset < writes.length; offset += 6) await Promise.all(writes.slice(offset, offset + 6)
      .map(({ id, value }) => env.MEDIA.put(`_benchmark/records/${id}.json`, value, { httpMetadata: { contentType: "application/json" } })));
  },
};
