import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: 97453 });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });

const ROUTER_ADDR = process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";
const ACV_ADDR = "0x1Dbb8336663198BFc18346Cfe8172Da722918284";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const WSDA_ABI = [
  ...ERC20_ABI,
  "function withdraw(uint256)"
];

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

async function main() {
  const pk3 = process.env.PRIVATE_KEY_3;
  if (!pk3) throw new Error("Missing PRIVATE_KEY_3 in .env");
  const cleanPk = pk3.startsWith("0x") ? pk3 : `0x${pk3}`;
  const wallet3 = new ethers.Wallet(cleanPk, provider);

  console.log("==========================================================================");
  console.log(`🔥 LIQUIDATE ACV ON WALLET 3 (0x91A14288b6aAb7936a823A92953AB8B6560Eab40)`);
  console.log("==========================================================================");

  const acv = new ethers.Contract(ACV_ADDR, ERC20_ABI, wallet3);
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, wallet3);
  const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, wallet3);

  const [bal, allowance, nativeInit] = await Promise.all([
    acv.balanceOf(wallet3.address),
    acv.allowance(wallet3.address, ROUTER_ADDR),
    provider.getBalance(wallet3.address)
  ]);

  console.log(`ACV Balance  : ${ethers.formatEther(bal)} ACV`);
  console.log(`Router Allow : ${ethers.formatEther(allowance)}`);
  console.log(`Native SDA   : ${ethers.formatEther(nativeInit)} SDA\n`);

  if (bal === 0n) {
    console.log("No ACV balance to sell.");
    return;
  }

  // 1. Approve router if allowance is low
  if (allowance < bal) {
    console.log("Step 1: Approving ACV to Router...");
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ? (feeData.gasPrice * 120n) / 100n : 5000000000n;
    const nonce = await provider.getTransactionCount(wallet3.address, "latest");
    const appTx = await acv.approve(ROUTER_ADDR, ethers.MaxUint256, {
      gasLimit: 85000n,
      gasPrice,
      nonce
    });
    console.log(`Approve Tx sent: ${appTx.hash}`);
    await appTx.wait(1);
    console.log("✅ Router approval confirmed!");
  } else {
    console.log("✅ ACV already approved for Router.");
  }

  // 2. Test quotes across fee tiers: 500, 3000, 10000
  console.log("\nStep 2: Testing best fee pool for liquidation...");
  const feeTiers = [10000, 3000, 500];
  let bestFee = 10000;
  let bestExpectedOut = 0n;

  for (const fee of feeTiers) {
    try {
      const out = await router.exactInputSingle.staticCall({
        tokenIn: ACV_ADDR,
        tokenOut: WSDA_ADDR,
        fee,
        recipient: wallet3.address,
        deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn: bal,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0
      });
      console.log(`   • Fee ${fee} tier: Expected output = ${ethers.formatEther(out)} WSDA`);
      if (out > bestExpectedOut) {
        bestExpectedOut = out;
        bestFee = fee;
      }
    } catch (err) {
      console.log(`   • Fee ${fee} tier: Reverted (${err.message.slice(0, 40)})`);
    }
  }

  if (bestExpectedOut === 0n) {
    console.log("Trying smaller chunks if full balance exceeded pool depth...");
    // Let's test half balance
    const halfBal = bal / 2n;
    for (const fee of feeTiers) {
      try {
        const out = await router.exactInputSingle.staticCall({
          tokenIn: ACV_ADDR,
          tokenOut: WSDA_ADDR,
          fee,
          recipient: wallet3.address,
          deadline: Math.floor(Date.now() / 1000) + 300,
          amountIn: halfBal,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0
        });
        console.log(`   • (Half) Fee ${fee} tier: Expected output = ${ethers.formatEther(out)} WSDA`);
        if (out > bestExpectedOut) {
          bestExpectedOut = out;
          bestFee = fee;
        }
      } catch {}
    }
  }

  console.log(`\nSelected Pool: Fee ${bestFee} tier (Est. ${ethers.formatEther(bestExpectedOut)} WSDA)`);

  // 3. Execute swap
  console.log("\nStep 3: Executing Swap on Pinetswap Router...");
  const feeDataSwap = await provider.getFeeData();
  const gasPriceSwap = feeDataSwap.gasPrice ? (feeDataSwap.gasPrice * 125n) / 100n : 5500000000n;
  const nonceSwap = await provider.getTransactionCount(wallet3.address, "latest");

  const swapTx = await router.exactInputSingle({
    tokenIn: ACV_ADDR,
    tokenOut: WSDA_ADDR,
    fee: bestFee,
    recipient: wallet3.address,
    deadline: Math.floor(Date.now() / 1000) + 300,
    amountIn: bal,
    amountOutMinimum: 0n, // Liquidate full balance
    sqrtPriceLimitX96: 0
  }, {
    gasLimit: 320000n,
    gasPrice: gasPriceSwap,
    nonce: nonceSwap
  });

  console.log(`Swap Tx Broadcast: ${swapTx.hash}`);
  const receipt = await swapTx.wait(1);
  console.log(`✅ Swap Confirmed in block ${receipt.blockNumber}!`);

  // 4. Unwrap WSDA to Native SDA
  console.log("\nStep 4: Unwrapping WSDA to Native SDA...");
  const wsdaBal = await wsda.balanceOf(wallet3.address);
  console.log(`WSDA to unwrap: ${ethers.formatEther(wsdaBal)} WSDA`);

  if (wsdaBal > 0n) {
    const feeDataUnwrap = await provider.getFeeData();
    const gasPriceUnwrap = feeDataUnwrap.gasPrice ? (feeDataUnwrap.gasPrice * 120n) / 100n : 5000000000n;
    const nonceUnwrap = await provider.getTransactionCount(wallet3.address, "latest");
    const unwrapTx = await wsda.withdraw(wsdaBal, {
      gasLimit: 90000n,
      gasPrice: gasPriceUnwrap,
      nonce: nonceUnwrap
    });
    console.log(`Unwrap Tx Broadcast: ${unwrapTx.hash}`);
    await unwrapTx.wait(1);
    console.log("✅ Unwrapped successfully to Native SDA!");
  }

  // 5. Final Balance Report
  const [finalAcv, finalWsda, finalNative] = await Promise.all([
    acv.balanceOf(wallet3.address),
    wsda.balanceOf(wallet3.address),
    provider.getBalance(wallet3.address)
  ]);

  console.log("\n==========================================================================");
  console.log(`🎉 LIQUIDATION COMPLETE!`);
  console.log(`   Final ACV Balance    : ${ethers.formatEther(finalAcv)} ACV`);
  console.log(`   Final WSDA Balance   : ${ethers.formatEther(finalWsda)} WSDA`);
  console.log(`   Final Native SDA     : ${ethers.formatEther(finalNative)} SDA`);
  console.log(`   Net SDA Recovered    : +${ethers.formatEther(finalNative - nativeInit)} SDA`);
  console.log("==========================================================================");
}

main().catch(console.error);

