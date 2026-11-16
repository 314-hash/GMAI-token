import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ArbitrageGmaiEngine } from "../engine/arbitrage_gmai_lp.js";

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute");
  const isContinuous = args.includes("--continuous") || args.includes("--loop");
  const maxRounds = Number(args.find((a) => a.startsWith("--rounds="))?.split("=")[1] || (isContinuous ? 0 : 1));
  const minProfitThreshold = Number(args.find((a) => a.startsWith("--min-profit="))?.split("=")[1] || 0.0005);
  const intervalSec = Number(args.find((a) => a.startsWith("--interval="))?.split("=")[1] || 15);
  const unwrapWsda = !args.includes("--no-unwrap");
  const gmaiRatio = Number(args.find((a) => a.startsWith("--gmai-ratio="))?.split("=")[1] || process.env.LP_PROFIT_SHARE || 0.10);
  const lpPct = Math.round(gmaiRatio * 100);
  const walletPct = 100 - lpPct;

  console.log("==========================================================================");
  console.log(`🦅 43-TOKEN TOP SCALPER & ${lpPct}% GMAI LIQUIDITY ACCUMULATOR`);
  console.log("==========================================================================");
  console.log(`Execution Mode : ${isLive ? "🚨 LIVE ON-CHAIN BROADCAST" : "🛡️ DRY-RUN SIMULATION (pass --execute for live)"}`);
  console.log(`GMAI Pool      : ${lpPct}% Routed directly into GMAI V3 Pool (0x64F2...B6eA)`);
  console.log(`Retained SDA   : ${walletPct}% Kept in executing wallet as native SDA reserve`);
  console.log(`Min Net Profit : >= +${minProfitThreshold} SDA per trade`);
  console.log(`Scan Interval  : ${intervalSec}s`);
  console.log(`Rounds Mode    : ${maxRounds === 0 ? "Continuous 24/7 Monitoring" : `${maxRounds} Round(s)`}`);
  console.log("==========================================================================\n");

  const engine = new ArbitrageGmaiEngine({
    isLive,
    minProfitThreshold,
    intervalSec,
    maxRounds,
    unwrapWsda,
    gmaiProfitRatio: gmaiRatio
  });

  const wallets = await engine.getWalletsOverview();
  console.log("👥 Fleet Wallets Status:");
  for (const w of wallets) {
    console.log(`   • [${w.key.toUpperCase().padEnd(8)}] ${w.address} | Native: ${w.nativeSda.toFixed(4)} SDA | WSDA: ${w.wsda.toFixed(4)} | GMAI: ${w.gmai.toFixed(4)} | Mempool: ${w.isClean ? "Clean" : "BUSY"}`);
  }
  console.log("");

  process.on("SIGINT", () => {
    console.log("\nReceived SIGINT. Gracefully shutting down...");
    engine.stop();
  });

  await engine.start();

  const finalStats = engine.getStats();
  console.log("\n==========================================================================");
  console.log("🏁 ARBITRAGE FLEET RUN COMPLETE");
  console.log("==========================================================================");
  console.log(`Total Rounds Scanned      : ${finalStats.roundsScanned}`);
  console.log(`Total Opportunities Found : ${finalStats.totalOpportunitiesFound}`);
  console.log(`Trades Executed           : ${finalStats.tradesExecuted}`);
  console.log(`Total Realized Net Profit : +${finalStats.netProfitSda.toFixed(5)} SDA`);
  console.log(`Retained Native SDA (${walletPct}%) : +${finalStats.accumulatedNativeSda.toFixed(5)} SDA`);
  console.log(`GMAI Pool Injected (${lpPct}%)  : +${finalStats.gmaiLiquidityInjectedSda.toFixed(5)} WSDA`);
  console.log(`GMAI Tokens Acquired      : +${finalStats.gmaiTokensAcquired.toFixed(4)} GMAI`);
  console.log("==========================================================================\n");
}

main().catch(console.error);
