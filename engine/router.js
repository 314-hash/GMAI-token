/**
 * Uniswap V3 Mathematical Router & Swap Quoter
 * High-precision local simulation of V3 constant virtual product swaps and spot pricing.
 */

const Q96 = 2n ** 96n;

/**
 * Calculates spot price of a token in terms of SDA
 * @param {string|bigint} sqrtPriceX96
 * @param {boolean} isToken0WSDA
 * @param {number} decimals
 * @returns {number} Spot price in SDA
 */
export function calculateSpotPrice(sqrtPriceX96, isToken0WSDA, decimals = 18) {
  try {
    const sp = BigInt(sqrtPriceX96);
    if (sp === 0n) return 0;
    const ratio = Number(sp) / Number(Q96);
    const p = ratio * ratio;

    let spotPrice;
    if (isToken0WSDA) {
      // token0 = WSDA, token1 = Token -> p is Token / WSDA
      spotPrice = p > 0 ? 1 / p : 0;
    } else {
      // token0 = Token, token1 = WSDA -> p is WSDA / Token
      spotPrice = p;
    }

    if (decimals !== 18) {
      const decAdjust = 10 ** (18 - decimals);
      spotPrice = isToken0WSDA ? spotPrice * decAdjust : spotPrice / decAdjust;
    }

    return spotPrice;
  } catch (err) {
    return 0;
  }
}

/**
 * Quotes a Uniswap V3 swap mathematically across active pool liquidity
 * @param {bigint} amountIn - Input amount in wei
 * @param {bigint} sqrtPriceX96 - Pool sqrtPriceX96
 * @param {bigint} liquidity - Pool active liquidity L
 * @param {number} feeTier - Fee tier (500, 3000, 10000)
 * @param {number} taxBps - Token transfer tax in basis points (e.g. 500 for 5%)
 * @param {boolean} zeroForOne - True if swapping token0 -> token1, false if token1 -> token0
 * @returns {{ amountOut: bigint, nextSqrtPriceX96: bigint, priceImpactPct: number }}
 */
export function quoteV3Swap(amountIn, sqrtPriceX96, liquidity, feeTier, taxBps = 0, zeroForOne = true) {
  if (!amountIn || amountIn <= 0n || !liquidity || liquidity <= 0n || !sqrtPriceX96 || sqrtPriceX96 <= 0n) {
    return { amountOut: 0n, nextSqrtPriceX96: 0n, priceImpactPct: 0 };
  }

  // 1. Fee deduction (feeTier is in millionths: 500 = 0.05%, 3000 = 0.3%, 10000 = 1%)
  const feeBig = BigInt(feeTier);
  const amountInAfterFee = (amountIn * (1000000n - feeBig)) / 1000000n;

  // 2. Token transfer tax on input if applicable
  const taxBig = BigInt(taxBps);
  const amountInEffective = taxBig > 0n ? (amountInAfterFee * (10000n - taxBig)) / 10000n : amountInAfterFee;

  if (amountInEffective <= 0n) {
    return { amountOut: 0n, nextSqrtPriceX96: 0n, priceImpactPct: 0 };
  }

  const sp = BigInt(sqrtPriceX96);
  const L = BigInt(liquidity);

  let nextSqrtPriceX96 = 0n;
  let amountOutRaw = 0n;

  if (zeroForOne) {
    // Swapping token0 -> token1: adding token0 reduces sqrtPrice
    // nextSqrtPriceX96 = (L * sp * Q96) / (L * Q96 + amountInEffective * sp)
    const numerator = L * sp * Q96;
    const denominator = (L * Q96) + (amountInEffective * sp);
    if (denominator === 0n) return { amountOut: 0n, nextSqrtPriceX96: 0n, priceImpactPct: 0 };
    nextSqrtPriceX96 = numerator / denominator;

    if (sp > nextSqrtPriceX96) {
      amountOutRaw = (L * (sp - nextSqrtPriceX96)) / Q96;
    }
  } else {
    // Swapping token1 -> token0: adding token1 increases sqrtPrice
    // nextSqrtPriceX96 = sp + (amountInEffective * Q96) / L
    nextSqrtPriceX96 = sp + (amountInEffective * Q96) / L;

    if (nextSqrtPriceX96 > sp) {
      const numX = L * (nextSqrtPriceX96 - sp) * Q96;
      const denX = nextSqrtPriceX96 * sp;
      if (denX > 0n) {
        amountOutRaw = numX / denX;
      }
    }
  }

  // 3. Token transfer tax on output if applicable
  const amountOut = taxBig > 0n ? (amountOutRaw * (10000n - taxBig)) / 10000n : amountOutRaw;

  // 4. Price impact calculation (percentage shift in effective spot price)
  const priceBefore = Number(sp) / Number(Q96);
  const priceAfter = Number(nextSqrtPriceX96) / Number(Q96);
  const priceImpactPct = priceBefore > 0 ? Math.abs((priceAfter - priceBefore) / priceBefore) * 200 : 0;

  return {
    amountOut,
    nextSqrtPriceX96,
    priceImpactPct
  };
}
