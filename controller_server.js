import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SwarmEngine } from "./loop_3buy_1sell_continuous.js";
import { ArbitrageGmaiEngine } from "./engine/arbitrage_gmai_lp.js";
import { SidraTempestEngine } from "./scripts/stae_automation.js";
import dotenv from "dotenv";

dotenv.config();

// Prevent uncaught RPC dropouts from terminating daemon
process.on("uncaughtException", (err) => {
  console.error("[Controller Recovered UncaughtException]:", err.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[Controller Recovered UnhandledRejection]:", reason?.message || reason);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const engine = new SwarmEngine({
  tradeSize: Number(process.env.TRADE_SIZE_SDA || 0.03),
  refundRatio: Number(process.env.RECOVER_GAS_PERCENT ? Number(process.env.RECOVER_GAS_PERCENT) / 100 : 0.90),
  rounds: Number(process.env.ROUNDS || 0),
  delay: Number(process.env.STEP_DELAY_MS || 3000),
  walletDelay: Number(process.env.WALLET_DELAY_MS || 30000),
  interval: Number(process.env.INTERVAL_MS || 30000),
  isLive: process.env.LIVE === "true"
});

const arbEngine = new ArbitrageGmaiEngine({
  isLive: process.env.LIVE === "true",
  minProfitThreshold: Number(process.env.ARB_MIN_PROFIT || 0.0005),
  intervalSec: Number(process.env.ARB_INTERVAL_SEC || 15),
  gmaiProfitRatio: Number(process.env.LP_PROFIT_SHARE || 0.10),
  unwrapWsda: true
});

const staeEngine = new SidraTempestEngine({
  isLive: process.env.LIVE_TRADING === "true",
  minTradeSda: Number(process.env.ARB_MIN_TRADE_SIZE_SDA || 5.0),
  maxTradeSda: Number(process.env.ARB_MAX_TRADE_SIZE_SDA || 5.0),
  wsdaReserveSda: Number(process.env.WSDA_RESERVE_SDA || 5.0)
});

// SSE Clients Registry
const sseClients = new Set();

const safeJsonStringify = (data) => JSON.stringify(data, (k, v) => typeof v === "bigint" ? v.toString() : v);

function broadcastSse(eventName, data) {
  const safeStr = safeJsonStringify(data);
  const payload = `event: ${eventName}\ndata: ${safeStr}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Attach Swarm Engine Event Broadcasters
engine.on("log", (entry) => broadcastSse("log", entry));
engine.on("status", (data) => broadcastSse("status", data));
engine.on("stats", (data) => broadcastSse("stats", data));
engine.on("round_start", (data) => broadcastSse("round_start", data));
engine.on("round_end", (data) => broadcastSse("round_end", data));

// Attach Arbitrage Engine Event Broadcasters
arbEngine.on("log", (entry) => broadcastSse("arb_log", entry));
arbEngine.on("stats", (data) => broadcastSse("arb_stats", data));
arbEngine.on("opportunities", (data) => broadcastSse("arb_opportunities", data));
arbEngine.on("trade_executed", (data) => broadcastSse("arb_trade_executed", data));

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // SSE Stream Endpoint
  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    res.write("event: connected\ndata: {}\n\n");
    sseClients.add(res);

    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // REST API: Get Current Engine State
  if (url.pathname === "/api/state" && req.method === "GET") {
    let spotPrice = 1.2975;
    try {
      spotPrice = await engine.getSpotPriceSda();
    } catch {}

    let wallets = [];
    try {
      wallets = await engine.getWalletsOverview();
    } catch {}

    const isActuallyRunning = engine.isRunning || engine.isExecutingRound;
    const responseData = {
      status: isActuallyRunning ? "RUNNING" : (engine.isTerminating ? "STOPPING" : "STOPPED"),
      config: engine.getConfig(),
      stats: engine.getStats(),
      spotPrice,
      wallets
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responseData));
    return;
  }

  // REST API: Get Wallets Overview
  if (url.pathname === "/api/wallets" && req.method === "GET") {
    try {
      const wallets = await engine.getWalletsOverview();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, wallets }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // REST API: Start Swarm Loop
  if (url.pathname === "/api/start" && req.method === "POST") {
    if (engine.isRunning) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Engine is already running." }));
      return;
    }

    try {
      const body = await parseJsonBody(req);
      engine.updateConfig(body);
      
      // Start in background without blocking response
      engine.start().catch((err) => {
        engine.log("error", `Engine start error: ${err.message}`);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Swarm loop initiated." }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // REST API: Graceful Stop
  if (url.pathname === "/api/stop" && req.method === "POST") {
    engine.stop();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Stop command signaled." }));
    return;
  }

  // REST API: Emergency Stop
  if (url.pathname === "/api/emergency-stop" && req.method === "POST") {
    engine.emergencyStop();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Emergency stop executed." }));
    return;
  }

  // REST API: Trigger Manual 1 Round
  if (url.pathname === "/api/trigger-round" && req.method === "POST") {
    if (engine.isRunning) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Cannot trigger manual round while loop is running." }));
      return;
    }

    engine.alignPoolAndToken().then(async () => {
      await engine.runRound(1);
    }).catch(err => {
      engine.log("error", `Manual round failed: ${err.message}`);
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Manual round execution launched." }));
    return;
  }

  // REST API: Update Config
  if (url.pathname === "/api/config" && req.method === "POST") {
    try {
      const body = await parseJsonBody(req);
      engine.updateConfig(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, config: engine.getConfig() }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // REST API: Get Arbitrage Engine State & Opportunities
  if (url.pathname === "/api/arb/state" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(safeJsonStringify({
      ok: true,
      stats: arbEngine.getStats(),
      opportunities: arbEngine.activeOpportunities
    }));
    return;
  }

  // REST API: Start Arbitrage Loop
  if (url.pathname === "/api/arb/start" && req.method === "POST") {
    if (arbEngine.isRunning) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Arbitrage engine is already running." }));
      return;
    }
    try {
      const body = await parseJsonBody(req);
      if (body.isLive !== undefined) arbEngine.isLive = Boolean(body.isLive);
      if (body.minProfitThreshold) arbEngine.minProfitThreshold = Number(body.minProfitThreshold);
      if (body.intervalSec) arbEngine.intervalSec = Number(body.intervalSec);
      if (body.gmaiProfitRatio !== undefined) arbEngine.gmaiProfitRatio = Number(body.gmaiProfitRatio);

      arbEngine.start().catch((err) => {
        arbEngine.log("error", `Arbitrage start error: ${err.message}`);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Arbitrage engine started." }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // REST API: Stop Arbitrage Loop
  if (url.pathname === "/api/arb/stop" && req.method === "POST") {
    arbEngine.stop();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Arbitrage engine stopped." }));
    return;
  }

  // REST API: Trigger Manual 1-Round Arbitrage Scan
  if (url.pathname === "/api/arb/scan" && req.method === "POST") {
    if (arbEngine.isExecutingScan) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Arbitrage scan is currently in progress." }));
      return;
    }
    arbEngine.runScanRound(arbEngine.stats.roundsScanned + 1).catch((err) => {
      arbEngine.log("error", `Manual arb scan failed: ${err.message}`);
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Arbitrage scan initiated." }));
    return;
  }

  // REST API: SIDRA TEMPEST (STAE) Snapshot
  if (url.pathname === "/api/stae/snapshot" && req.method === "GET") {
    const ledgerSnap = staeEngine.ledger.getDashboardSnapshot();
    const riskMetrics = staeEngine.riskEngine.getMetricsSnapshot();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      safeJsonStringify({
        ok: true,
        isLive: staeEngine.isLive,
        round: staeEngine.round,
        riskMetrics,
        riskConfig: staeEngine.riskEngine.config,
        ...ledgerSnap
      })
    );
    return;
  }

  // REST API: SIDRA TEMPEST (STAE) Trigger Scan/Execution Cycle
  if (url.pathname === "/api/stae/cycle" && req.method === "POST") {
    try {
      const cycleRes = await staeEngine.runCycle();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(safeJsonStringify({ ok: true, ...cycleRes }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // REST API: SIDRA TEMPEST (STAE) Emergency Stop / Reset
  if (url.pathname === "/api/stae/emergency-stop" && req.method === "POST") {
    const body = await parseJsonBody(req);
    if (body.reset) {
      staeEngine.riskEngine.resetCircuitBreaker();
    } else {
      staeEngine.riskEngine.triggerEmergencyStop(body.reason || "Manual Operator Emergency Stop from Dashboard");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(safeJsonStringify({ ok: true, riskMetrics: staeEngine.riskEngine.getMetricsSnapshot() }));
    return;
  }

  // Static File Serving
  let reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
  let filePath = path.join(PUBLIC_DIR, reqPath);

  // Security check: ensure path is within PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

export function startServer(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`\n==========================================================================`);
      console.log(`🚀 GMAI SWARM MISSION CONTROL DASHBOARD ONLINE`);
      console.log(`==========================================================================`);
      console.log(`🌐 Local Dashboard : http://localhost:${port}`);
      console.log(`🎯 Target Asset   : GMAI (0x4765...ca04)`);
      console.log(`⛓️  Blockchain     : Sidra Chain (Chain ID: 97453)`);
      console.log(`🤖 Engine Script  : loop_3buy_1sell_continuous.js`);
      console.log(`==========================================================================\n`);
      resolve(server);
    });
  });
}

// Auto-start if executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer(PORT);
}
