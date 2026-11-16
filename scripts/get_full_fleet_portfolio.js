import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });

const WSDA_ADDR = "0xE4095a910209D7BE03B55D02F40d4554B1666182";

const configTokens = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "tokens.json"), "utf8")).tokens;
const tokenMap = new Map();
configTokens.forEach(t => tokenMap.set(t.address.toLowerCase(), { symbol: t.symbol, address: t.address, decimals: t.decimals || 18 }));
tokenMap.set(WSDA_ADDR.toLowerCase(), { symbol: "WSDA", address: WSDA_ADDR, decimals: 18 });
tokenMap.set("0x1dbb8336663198bfc18346cfe8172da722918284", { symbol: "ACV", address: "0x1Dbb8336663198BFc18346Cfe8172Da722918284", decimals: 18 });

const tokenList = Array.from(tokenMap.values());

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const wallets = [];
  for (let i = 1; i <= 15; i++) {
    const pk = process.env[`PRIVATE_KEY_${i}`] || (i === 1 ? process.env.PRIVATE_KEY : null);
    if (!pk) continue;
    const cleanPk = pk.startsWith("0x") ? pk : `0x${pk}`;
    const w = new ethers.Wallet(cleanPk, provider);
    wallets.push({ index: i, address: w.address });
  }

  // Pre-create contracts
  const tokenContracts = tokenList.map(t => ({
    symbol: t.symbol,
    contract: new ethers.Contract(t.address, ERC20_ABI, provider)
  }));

  const fleetSummary = [];
  const tokenTotals = new Map();
  let grandTotalNativeWei = 0n;

  for (const w of wallets) {
    const nativeBal = await provider.getBalance(w.address);
    grandTotalNativeWei += nativeBal;

    // Check balances in chunks of 15
    const walletTokens = [];
    const CHUNK = 15;
    for (let c = 0; c < tokenContracts.length; c += CHUNK) {
      const slice = tokenContracts.slice(c, c + CHUNK);
      const res = await Promise.all(
        slice.map(async (tc) => {
          try {
            const b = await tc.contract.balanceOf(w.address);
            if (b > 0n) return { symbol: tc.symbol, amount: b };
          } catch {}
          return null;
        })
      );
      res.filter(Boolean).forEach(r => {
        walletTokens.push(r);
        const cur = tokenTotals.get(r.symbol) || 0n;
        tokenTotals.set(r.symbol, cur + r.amount);
      });
    }

    fleetSummary.push({
      wallet: `Wallet ${w.index}`,
      address: w.address,
      nativeSda: Number(ethers.formatEther(nativeBal)),
      tokens: walletTokens.map(t => ({
        symbol: t.symbol,
        amount: Number(ethers.formatEther(t.amount))
      }))
    });
  }

  const totalsArray = Array.from(tokenTotals.entries())
    .map(([symbol, raw]) => ({
      symbol,
      total: Number(ethers.formatEther(raw))
    }))
    .filter(t => t.total > 0.000001)
    .sort((a, b) => b.total - a.total);

  const grandTotalNativeSda = Number(ethers.formatEther(grandTotalNativeWei));
  const totalWsda = totalsArray.find(t => t.symbol === "WSDA")?.total || 0;
  const grandTotalSda = grandTotalNativeSda + totalWsda;

  console.log(JSON.stringify({
    grandTotalSda,
    grandTotalNativeSda,
    totalWsda,
    totalsArray,
    fleetSummary
  }, null, 2));
}

main().catch(console.error);
