import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });
provider.pollingInterval = 800;

const ROUTER_ADDR = process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";
const GAS_PRICE = 4000000000n;

const WSDA_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function deposit() payable",
  "function withdraw(uint256)"
];

async function getFastNonce(address) {
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(address, "latest"),
    provider.getTransactionCount(address, "pending")
  ]);
  return Math.max(latest, pending);
}

async function main() {
  const targetSda = Number(process.argv.find((a) => a.startsWith("--amount="))?.split("=")[1] || "10.0");
  const targetWei = ethers.parseEther(targetSda.toString());
  const minGasBufferWei = ethers.parseEther("0.25");

  console.log("==========================================================================");
  console.log(`⚡ PRE-WRAPPING ${targetSda.toFixed(2)} WSDA ACROSS ALL 5 WALLETS FOR INSTANT 5 SDA TRADES`);
  console.log("==========================================================================\n");

  for (let i = 1; i <= 50; i++) {
    const pk = process.env[`PRIVATE_KEY_${i}`];
    if (!pk) continue;
    const cleanPk = pk.startsWith("0x") ? pk : `0x${pk}`;
    const signer = new ethers.Wallet(cleanPk, provider);
    const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);

    try {
      const [nativeBal, wsdaBal, allowance] = await Promise.all([
        provider.getBalance(signer.address),
        wsda.balanceOf(signer.address),
        wsda.allowance(signer.address, ROUTER_ADDR)
      ]);

      console.log(`🔹 [WALLET${i}] ${signer.address}`);
      console.log(`   Before -> Native: ${Number(ethers.formatEther(nativeBal)).toFixed(4)} SDA | WSDA: ${Number(ethers.formatEther(wsdaBal)).toFixed(4)} WSDA`);

      if (wsdaBal < targetWei) {
        const neededWei = targetWei - wsdaBal;
        if (nativeBal >= neededWei + minGasBufferWei) {
          const nonce = await getFastNonce(signer.address);
          const tx = await wsda.deposit({
            value: neededWei,
            gasLimit: 90000n,
            gasPrice: GAS_PRICE,
            nonce
          });
          console.log(`   ⏳ Wrapping +${ethers.formatEther(neededWei)} SDA -> WSDA (tx: ${tx.hash})...`);
          await tx.wait(1);
        } else {
          console.log(`   ⚠️ Insufficient native SDA to wrap full ${targetSda} WSDA while keeping 0.25 SDA gas buffer.`);
        }
      } else {
        console.log(`   ✅ Already holds >= ${targetSda.toFixed(2)} WSDA.`);
      }

      if (allowance < targetWei * 100n) {
        const nonceApp = await getFastNonce(signer.address);
        const appTx = await wsda.approve(ROUTER_ADDR, ethers.MaxUint256, {
          gasLimit: 75000n,
          gasPrice: GAS_PRICE,
          nonce: nonceApp
        });
        await appTx.wait(1);
        console.log(`   🔓 Router Max-Approved for WSDA.`);
      }

      const [afterNative, afterWsda] = await Promise.all([
        provider.getBalance(signer.address),
        wsda.balanceOf(signer.address)
      ]);
      console.log(`   After  -> Native: ${Number(ethers.formatEther(afterNative)).toFixed(4)} SDA | WSDA: ${Number(ethers.formatEther(afterWsda)).toFixed(4)} WSDA\n`);
    } catch (err) {
      console.error(`   ❌ [WALLET${i}] Error wrapping WSDA: ${err.message}\n`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

