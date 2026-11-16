import fs from "fs";
import path from "path";

const LOCKS_DIR = path.join(process.cwd(), "data", "wallet_locks");
if (!fs.existsSync(LOCKS_DIR)) {
  fs.mkdirSync(LOCKS_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Multi-Wallet Fleet Helper:
 * Enables running multiple automations across different terminal windows
 * by cleanly partitioning or dynamically coordinating the 15 fleet wallets without nonce collisions.
 *
 * Supported syntaxes for --wallet= or --wallets=:
 *   --wallet=1-5               -> Wallets 1 through 5
 *   --wallet=6-10              -> Wallets 6 through 10
 *   --wallet=11-15             -> Wallets 11 through 15
 *   --wallet=1,2,3             -> Specific list of wallets
 *   --wallet=wallet1,wallet3   -> Specific list of wallets
 *   --wallet=wallet4           -> Single wallet
 *   --wallet=all               -> All available fleet wallets
 */
export function parseTargetWallets(walletArg, availableKeys) {
  if (!walletArg || ["all", "swarm", "fleet", "all-fleet"].includes(walletArg.toLowerCase())) {
    return availableKeys;
  }

  // Check range e.g. "1-5" or "wallet1-wallet5"
  if (walletArg.includes("-")) {
    const parts = walletArg.split("-").map((p) => parseInt(p.replace(/\D/g, ""), 10));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const [start, end] = parts;
      const matched = [];
      for (let i = start; i <= end; i++) {
        const k = `wallet${i}`;
        if (availableKeys.includes(k)) matched.push(k);
      }
      if (matched.length > 0) return matched;
    }
  }

  // Check comma-separated e.g. "wallet1,wallet2" or "1,2,3"
  const tokens = walletArg.split(",").map((s) => s.trim().toLowerCase());
  const matched = [];
  for (const t of tokens) {
    const formatted = t.startsWith("wallet") ? t : `wallet${t}`;
    if (availableKeys.includes(formatted)) {
      matched.push(formatted);
    }
  }

  return matched.length > 0 ? matched : availableKeys;
}

/**
 * Reads the lock metadata for a specific wallet
 */
function readWalletLock(walletKey) {
  const filePath = path.join(LOCKS_DIR, `${walletKey}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data;
  } catch {
    return null;
  }
}

/**
 * Writes the lock metadata for a specific wallet
 */
function writeWalletLock(walletKey, data) {
  const filePath = path.join(LOCKS_DIR, `${walletKey}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
  } catch (err) {
    console.warn(`[WalletLock] Write warning for ${walletKey}: ${err.message}`);
  }
}

/**
 * Checks if a wallet is currently free and has satisfied the 5-second cooldown
 */
export function isWalletReady(walletKey, minDelayMs = 5000) {
  const lock = readWalletLock(walletKey);
  if (!lock) return true;

  const now = Date.now();
  // If another process is currently broadcasting a transaction
  if (lock.inFlight) {
    // Treat locks older than 45s as abandoned/stale
    if (now - (lock.lockedAt || 0) < 45000) {
      return false;
    }
  }

  // Check minimum 5-second delay since last transaction
  const timeSinceLast = now - (lock.lastUsed || 0);
  if (timeSinceLast < minDelayMs) {
    return false;
  }

  return true;
}

/**
 * Cross-Process Wallet Locking & 5-Second Cooldown:
 * Ensures Window 1 and Window 2 NEVER broadcast transactions from the same wallet
 * in the same block, completely preventing nonce collisions and stuck mempool transactions.
 */
export async function acquireWalletLock(walletKey, walletAddress, provider, minDelayMs = 5000, timeoutMs = 60000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const lock = readWalletLock(walletKey);
    const now = Date.now();

    // 1. Wait if another window has an active in-flight broadcast
    if (lock && lock.inFlight) {
      const lockAge = now - (lock.lockedAt || 0);
      if (lockAge < 45000) {
        await sleep(600);
        continue;
      }
    }

    // 2. Enforce 5-second per-wallet cooldown
    const timeSinceLast = lock ? now - (lock.lastUsed || 0) : minDelayMs;
    if (timeSinceLast < minDelayMs) {
      const waitMs = minDelayMs - timeSinceLast;
      await sleep(Math.max(200, waitMs));
      continue;
    }

    // 3. Verify on-chain that the mempool is 100% clean (latest === pending)
    let cleanNonce = null;
    try {
      const [latest, pending] = await Promise.all([
        provider.getTransactionCount(walletAddress, "latest"),
        provider.getTransactionCount(walletAddress, "pending")
      ]);

      if (latest !== pending) {
        // A transaction from another window is still pending in the mempool
        await sleep(1500);
        continue;
      }

      cleanNonce = latest;
    } catch {
      await sleep(1000);
      continue;
    }

    // 4. Claim the lock
    writeWalletLock(walletKey, {
      pid: process.pid,
      inFlight: true,
      lockedAt: Date.now(),
      lastUsed: Date.now(),
      walletAddress,
      nonce: cleanNonce
    });

    return {
      nonce: cleanNonce,
      release: async () => {
        releaseWalletLock(walletKey);
      }
    };
  }

  // If timeout reached, fallback to fresh latest count
  const fallbackNonce = await provider.getTransactionCount(walletAddress, "latest");
  return {
    nonce: fallbackNonce,
    release: async () => {
      releaseWalletLock(walletKey);
    }
  };
}

/**
 * Releases the wallet lock and stamps the current time for the 5-second cooldown
 */
export function releaseWalletLock(walletKey) {
  const lock = readWalletLock(walletKey) || {};
  writeWalletLock(walletKey, {
    ...lock,
    inFlight: false,
    lastUsed: Date.now()
  });
}

/**
 * Helper to safely execute an asynchronous transaction with automatic lock acquisition & release
 */
export async function withWalletLock(walletKey, walletAddress, provider, actionFn, minDelayMs = 5000) {
  const lock = await acquireWalletLock(walletKey, walletAddress, provider, minDelayMs);
  try {
    return await actionFn(lock.nonce);
  } finally {
    await lock.release();
  }
}
