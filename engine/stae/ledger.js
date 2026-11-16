/**
 * SIDRA TEMPEST ARBITRAGE ENGINE (STAE) — AUDITABLE DATABASE & ACCOUNTING LEDGER
 *
 * Persists all records in `data/stae/` as append-only JSONL ledgers and state snapshots:
 * - wallets.json (Strictly public addresses & balances — NEVER private keys)
 * - pool_registry.json
 * - opportunities.jsonl
 * - transactions.jsonl
 * - allocations.jsonl
 * - risk_events.jsonl
 * - security_findings.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data", "stae");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function serializeBigInt(obj) {
  return JSON.stringify(obj, (key, value) => {
    // Never serialize any field resembling a private key
    if (/private|secret|mnemonic/i.test(key)) return "[REDACTED]";
    return typeof value === "bigint" ? value.toString() : value;
  });
}

export class AuditableLedger {
  constructor() {
    ensureDataDir();
    this.paths = {
      wallets: path.join(DATA_DIR, "wallets.json"),
      poolRegistry: path.join(DATA_DIR, "pool_registry.json"),
      opportunities: path.join(DATA_DIR, "opportunities.jsonl"),
      transactions: path.join(DATA_DIR, "transactions.jsonl"),
      allocations: path.join(DATA_DIR, "allocations.jsonl"),
      riskEvents: path.join(DATA_DIR, "risk_events.jsonl"),
      securityFindings: path.join(DATA_DIR, "security_findings.json")
    };
  }

  saveWalletFleetSnapshot(walletsArray) {
    ensureDataDir();
    const safeWallets = walletsArray.map((w) => ({
      walletId: w.walletId || w.key,
      address: w.address,
      nativeSda: w.nativeSda,
      wsda: w.wsda,
      gmai: w.gmai || 0,
      combinedSda: Number(((w.nativeSda || 0) + (w.wsda || 0)).toFixed(6)),
      nonce: w.nonce || 0,
      isCleanNonce: Boolean(w.isCleanNonce),
      realizedProfitSda: w.realizedProfitSda || 0,
      tradesExecuted: w.tradesExecuted || 0,
      updatedAt: new Date().toISOString()
    }));
    fs.writeFileSync(this.paths.wallets, JSON.stringify(safeWallets, null, 2), "utf8");
  }

  savePoolRegistry(market) {
    ensureDataDir();
    const registry = [];
    const now = new Date().toISOString();
    for (const token of market || []) {
      for (const p of token.pools || []) {
        registry.push({
          poolAddress: p.poolAddress,
          tokenSymbol: token.symbol,
          tokenAddress: token.address,
          decimals: token.decimals || 18,
          taxBps: token.taxBps || 0,
          feeTier: p.feeTier,
          isToken0WSDA: p.isToken0WSDA,
          sqrtPriceX96: String(p.sqrtPriceX96 || "0"),
          liquidity: String(p.liquidity || "0"),
          virtualWsdaDepthSda: p.virtualWsdaDepthSda || 0,
          spotPriceSda: p.spotPriceSda || 0,
          isHealthy: Boolean(p.isHealthy),
          updatedAt: now
        });
      }
    }
    fs.writeFileSync(this.paths.poolRegistry, JSON.stringify(registry, null, 2), "utf8");
    return registry;
  }

  appendOpportunity(oppRecord) {
    ensureDataDir();
    const entry = {
      ...oppRecord,
      discoveredAt: new Date().toISOString()
    };
    fs.appendFileSync(this.paths.opportunities, serializeBigInt(entry) + "\n", "utf8");
  }

  appendTransaction(txRecord) {
    ensureDataDir();
    const entry = {
      ...txRecord,
      createdAt: new Date().toISOString()
    };
    fs.appendFileSync(this.paths.transactions, serializeBigInt(entry) + "\n", "utf8");
  }

  appendAllocation(allocRecord) {
    ensureDataDir();
    const entry = {
      ...allocRecord,
      createdAt: new Date().toISOString()
    };
    fs.appendFileSync(this.paths.allocations, serializeBigInt(entry) + "\n", "utf8");
  }

  appendRiskEvent(severity, category, message, metadata = {}) {
    ensureDataDir();
    const entry = {
      eventId: `RISK-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      severity,
      category,
      message,
      metadata,
      createdAt: new Date().toISOString()
    };
    fs.appendFileSync(this.paths.riskEvents, serializeBigInt(entry) + "\n", "utf8");
  }

  saveSecurityReport(report) {
    ensureDataDir();
    fs.writeFileSync(this.paths.securityFindings, serializeBigInt(report), "utf8");
  }

  readRecentJsonl(filePath, limit = 50) {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  getDashboardSnapshot() {
    const readJson = (p, fallback) => {
      try {
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback;
      } catch {
        return fallback;
      }
    };

    return {
      wallets: readJson(this.paths.wallets, []),
      poolRegistry: readJson(this.paths.poolRegistry, []),
      securityReport: readJson(this.paths.securityFindings, null),
      recentOpportunities: this.readRecentJsonl(this.paths.opportunities, 40),
      recentTransactions: this.readRecentJsonl(this.paths.transactions, 50),
      recentAllocations: this.readRecentJsonl(this.paths.allocations, 30),
      recentRiskEvents: this.readRecentJsonl(this.paths.riskEvents, 30)
    };
  }
}

