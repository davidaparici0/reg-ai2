// The long-running ingestion poller. One iteration = reclaim stale jobs, claim one
// pending doc, process it. The loop drains immediately when work exists and backs off
// when idle. runOnce() is exported so a single iteration can be tested without a loop.
import "server-only";
import { claimNextDocument, reclaimStaleDocuments } from "@/lib/ingest/claim";
import { processDocument } from "@/lib/ingest/process-document";

const POLL_INTERVAL_MS = 2000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runOnce(): Promise<string | null> {
  await reclaimStaleDocuments();
  const job = await claimNextDocument();
  if (!job) return null;
  await processDocument(job);
  return job.id;
}

export async function runForever(): Promise<void> {
  let running = true;
  const stop = () => { running = false; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(JSON.stringify({ event: "worker.start", pollMs: POLL_INTERVAL_MS }));

  while (running) {
    try {
      const id = await runOnce();
      if (!id) await sleep(POLL_INTERVAL_MS); // idle -> back off; work present -> drain
    } catch (err) {
      console.error(JSON.stringify({ event: "worker.tick_error", error: String(err) }));
      await sleep(POLL_INTERVAL_MS);
    }
  }
  console.log(JSON.stringify({ event: "worker.stop" }));
}
