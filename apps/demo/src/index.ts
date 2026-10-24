import { resolve } from "node:path";
import express from "express";
import { Client } from "xrpl";
import { EXPLORER, PORTS, address, buyQuote, wsUrl, type DemoEvent } from "@demo/common";

/**
 * Demo server (AGENTS.md sections 7.5 and 7.6). Apps POST events to /events; the page
 * subscribes to /stream (server-sent events). The two buttons run the real buyer flow
 * from this process, one at a time, because both use the buyer's account sequence.
 */

const history: DemoEvent[] = [];
const subscribers = new Set<express.Response>();
const client = new Client(wsUrl());
client.on("error", () => {});

function publish(event: DemoEvent): void {
  const e = { ...event, at: event.at ?? Date.now() };
  history.push(e);
  if (history.length > 500) history.shift();
  const frame = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of subscribers) res.write(frame);
}

let queue: Promise<unknown> = Promise.resolve();
let running = 0;

const app = express();
app.use(express.json());
app.use(express.static(resolve(import.meta.dirname, "../public")));

app.post("/events", (req, res) => {
  const e = req.body as DemoEvent;
  if (typeof e?.type === "string" && typeof e.source === "string") publish(e);
  res.status(204).end();
});

app.get("/stream", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(`event: config\ndata: ${JSON.stringify({ explorer: EXPLORER, buyer: address("buyer"), seller: address("seller"), arbiter: address("arbiter") })}\n\n`);
  for (const e of history) res.write(`data: ${JSON.stringify(e)}\n\n`);
  subscribers.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    subscribers.delete(res);
  });
});

app.get("/balances", async (_req, res) => {
  const [buyer, seller] = await Promise.all([address("buyer"), address("seller")].map((a) => client.getXrpBalance(a).catch(() => null)));
  res.json({ buyer, seller });
});

app.post("/run/:mode", (req, res) => {
  const mode = req.params.mode === "cheat" ? "cheat" : "honest";
  running++;
  publish({ type: "run_started", source: "buyer", detail: { mode, queued: running } });
  queue = queue
    .then(() => buyQuote({ symbol: "XRP", mode }))
    .then((r) => publish({ type: "receipt", source: "buyer", orderId: r.orderId, detail: { receiptChecked: r.receiptValid, mode, verdict: r.receipt?.verdict } }))
    .catch((err) => publish({ type: "error", source: "buyer", detail: { mode, message: err instanceof Error ? err.message : String(err) } }))
    .finally(() => running--);
  res.status(202).json({ queued: running });
});

await client.connect();
app.listen(PORTS.demo, () => console.log(`demo on http://localhost:${PORTS.demo}`));
