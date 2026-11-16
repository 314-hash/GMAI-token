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
const extraTokens = [
  { symbol: "ATES", address: "0x05322f2356e8FfdC28c4a5e69d4FEebEbbB33649" },
  { symbol: "AGFU", address: "0xfaa37c365fa4d345b5115ede02f1bf8a9e721b48" },
  { symbol: "ONETK", address: "0x9694d371f566fcf6527c0f62e4f80553783ac7d7" },
  { symbol: "JSFT", address: "0xb4ac5dd62f700e271bffb52aeae1dba40135427f" },
  { symbol: "SDIP", address: "0x00313151A7e74CE5108ad12c1B444ed7b458947c" },
  { symbol: "WPay", address: "0x64c595d4c4063c49b8c3a8b291e6f5c3c205f496" },
  { symbol: "XAUS", address: "0x8d7a3eefbc25187a229d442c20b443d7675b44cd" },
  { symbol: "PINE", address: "0xd1e6528d10398502677dfcb3ccd2fd4a657edf99" },
  { symbol: "SKMH", address: "0xe787bffc078a0231a038be1fb199b9c6fd1d511a" },
  { symbol: "DMCS", address: "0x8f2e99691855a5663beb39deb9075f28b3dcc51b" },
  { symbol: "SIT", address: "0xf102009cd862fc714e01c46591c3df10d097f7b9" },
  { symbol: "SMAf", address: "0x2ce9e7c168035d61cc3a3655949c147c063eecc4" },
  { symbol: "ARMS", address: "0x9b61324f0bee10f4624fe6e75c60943b73125e81" },
  { symbol: "STSX", address: "0x84fb6ad958a73a9e978c2bf00719b84d8b73304a" },
  { symbol: "GLNs", address: "0xe1a8ffd7280d5a278a9e8c6daff6d391b59081b4" },
  { symbol: "SDS", address: "0x9ba4035871119991fc7b420873345f9be92af146" },
  { symbol: "ZSM", address: "0x828df8009add5279b9133c39955ee95bdcaae476" },
  { symbol: "FREEt", address: "0x0914bf761af71f4a39dce0e9ce71b7ed96c457e3" },
  { symbol: "ACV", address: "0x1Dbb8336663198BFc18346Cfe8172Da722918284" },
  { symbol: "WSDA", address: WSDA_ADDR }
];

const tokenMap = new Map();
configTokens.forEach(t => tokenMap.set(t.address.toLowerCase(), { symbol: t.symbol, address: t.address }));
extraTokens.forEach(t => tokenMap.set(t.address.toLowerCase(), { symbol: t.symbol, address: t.address }));

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

async function scanFleet() {
  const wallets = [];
  for (let i = 1; i <= 15; i++) {
    const pk = process.env[`PRIVATE_KEY_${i}`] || (i === 1 ? process.env.PRIVATE_KEY : null);
    if (!pk) continue;
    const cleanPk = pk.startsWith("0x") ? pk : `0x${pk}`;
    const w = new ethers.Wallet(cleanPk, provider);
    wallets.push({ index: i, address: w.address });
  }

  const tokenList = Array.from(tokenMap.values());
  const tokenContracts = tokenList.map(t => ({
    ...t,
    contract: new ethers.Contract(t.address, ERC20_ABI, provider)
  }));

  const results = [];
  let totalNativeSda = 0n;
  const tokenTotals = {};

  for (const w of wallets) {
    const nativeBal = await provider.getBalance(w.address);
    totalNativeSda += nativeBal;
    const holdings = [];

    // Query tokens in parallel chunks of 10
    const chunkSize = 10;
    for (let c = 0; c < tokenContracts.length; c += chunkSize) {
      const chunk = tokenContracts.slice(c, c + chunkSize);
      const chunkRes = await Promise.all(
        chunk.map(async (t) => {
          try {
            const b = await t.contract.balanceOf(w.address);
            if (b > 0n) {
              return { symbol: t.symbol, address: t.address, balance: b };
            }
          } catch {}
          return null;
        })
      );
      chunkRes.filter(Boolean).forEach(h => holdings.push(h));
    }

    holdings.forEach(h => {
      if (!tokenTotals[h.symbol]) tokenTotals[h.symbol] = 0n;
      tokenTotals[h.symbol] += h.balance;
    });

    results.push({
      wallet: `Wallet ${w.index}`,
      address: w.address,
      nativeSda: nativeBal,
      holdings
    });
  }

  console.log(JSON.stringify({
    totalNativeSdaWei: totalNativeSda.toString(),
    wallets: results.map(r => ({
      wallet: r.wallet,
      address: r.address,
      nativeSda: ethers.formatEther(r.nativeSda),
      tokens: r.holdings.map(h => ({
        symbol: h.symbol,
        balance: ethers.formatEther(h.balance),
        balanceRaw: h.balance.toString()
      }))
    })),
    aggregateTokens: Object.entries(tokenTotals).map(([sym, tot]) => ({
      symbol: sym,
      total: ethers.formatEther(tot)
    }))
  }, null, 2));
}

scanFleet().catch(err => {
  console.error("Scan error:", err);
  process.exit(1);
});
