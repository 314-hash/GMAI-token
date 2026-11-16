/**
 * Uniswap V3 Edge Mathematical Router
 * Pure BigInt execution optimized for Cloudflare Workers V8 runtime.
 */

const Q96 = 2n ** 96n;

export function calculateSpotPrice(sqrtPriceX96, isToken0WSDA, decimals = 18) {
  try {
    const sp = BigInt(sqrtPriceX96);
    if (sp === 0n) return 0;
    const ratio = Number(sp) / Number(Q96);
    const p = ratio * ratio;

    let spotPrice;
    if (isToken0WSDA) {
      spotPrice = p > 0 ? 1 / p : 0;
    } else {
      spotPrice = p;
    }

    if (decimals !== 18) {
      const decAdjust = 10 ** (18 - decimals);
      spotPrice = isToken0WSDA ? spotPrice * decAdjust : spotPrice / decAdjust;
    }

    return spotPrice;
  } catch {
    return 0;
  }
}

export function quoteV3Swap(amountIn, sqrtPriceX96, liquidity, feeTier, taxBps = 0, zeroForOne = true) {
  if (!amountIn || amountIn <= 0n || !liquidity || liquidity <= 0n || !sqrtPriceX96 || sqrtPriceX96 <= 0n) {
    return { amountOut: 0n, nextSqrtPriceX96: 0n, priceImpactPct: 0 };
  }

  const feeBig = BigInt(feeTier);
  const amountInAfterFee = (amountIn * (1000000n - feeBig)) / 1000000n;
  const currentSqrtP = BigInt(sqrtPriceX96);
  const L = BigInt(liquidity);

  let nextSqrtP = 0n;
  let amountOutRaw = 0n;

  if (zeroForOne) {
    const numerator = L * currentSqrtP;
    const denominator = L + (amountInAfterFee * currentSqrtP) / Q96;
    if (denominator === 0n) return { amountOut: 0n, nextSqrtPriceX96: 0n, priceImpactPct: 0 };
    nextSqrtP = numerator / denominator;
    amountOutRaw = (L * (currentSqrtP - nextSqrtP)) / Q96;
  } else {
    nextSqrtP = currentSqrtP + (amountInAfterFee * Q96) / L;
    if (currentSqrtP === 0n || nextSqrtP === 0n) return { amountOut: 0n, nextSqrtPriceX96: 0n, priceImpactPct: 0 };
    amountOutRaw = (L * Q96 * (nextSqrtP - currentSqrtP)) / (currentSqrtP * nextSqrtP);
  }

  let finalAmountOut = amountOutRaw;
  if (taxBps > 0) {
    finalAmountOut = (amountOutRaw * (10000n - BigInt(taxBps))) / 10000n;
  }

  const currentPriceRatio = Number(currentSqrtP) / Number(Q96);
  const nextPriceRatio = Number(nextSqrtP) / Number(Q96);
  const priceBefore = currentPriceRatio * currentPriceRatio;
  const priceAfter = nextPriceRatio * nextPriceRatio;
  const priceImpactPct = priceBefore > 0 ? Math.abs((priceAfter - priceBefore) / priceBefore) * 100 : 0;

  return {
    amountOut: finalAmountOut,
    nextSqrtPriceX96: nextSqrtP,
    priceImpactPct
  };
}
