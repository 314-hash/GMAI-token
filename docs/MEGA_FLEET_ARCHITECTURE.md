# GMAI Mega-Fleet 15-Wallet Autonomous Trading Architecture

## Technical Architecture & Operational Specification

This document details the internal mechanics, multi-wallet fleet orchestration, mathematical optimization algorithms, and risk protection guarantees of the GMAI 15-wallet algorithmic fleet on Sidra Chain (`97453`).

---

## 1. Fleet Partitioning & Squad Assignments

The 15 private keys configured in `.env` are partitioned into 3 isolated execution squads:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FLEET ORCHESTRATION & SQUAD TOPOLOGY                     │
├───────────────┬───────────────────────────────┬─────────────────────────────┤
│ SQUAD         │ WALLETS                       │ CORE MANDATE                │
├───────────────┼───────────────────────────────┼─────────────────────────────┤
│ Squad 1       │ Wallet 1 – Wallet 5           │ Whale Copy Trading          │
│ Squad 2       │ Wallet 6 – Wallet 10          │ Dynamic Multi-Tier Arb      │
│ Squad 3       │ Wallet 11 – Wallet 15         │ Top Gainers/Losers Scalping │
└───────────────┴───────────────────────────────┴─────────────────────────────┘
```

### Capital Allocation & Reserves
* **Squad 1 (W1–W5)**: **100.00 WSDA** base working capital reserve + native SDA for gas.
* **Squad 2 (W6–W10)**: **10.00 WSDA** base working capital reserve + native SDA for gas.
* **Squad 3 (W11–W15)**: **5.00 WSDA** base working capital reserve + native SDA for gas.
* **Total Working Capital**: **575.00 WSDA** deployed across the 15 fleet wallets.

---

## 2. Infallible Risk Invariants

### Invariant 1: Zero Speculative Tokens Held (100% Round-Trip Scalping)
Every swap executed by the fleet must satisfy the cyclic invariant:
$$\text{WSDA} \xrightarrow{\text{Leg 1}} \text{Token} \xrightarrow{\text{Leg 2}} \text{WSDA}$$

If a directional buy is detected without an immediate, profitable cross-pool exit back to `WSDA`, the trade is rejected **pre-flight** with zero gas spent and zero native wrapping.

### Invariant 2: Pre-Flight On-Chain Simulation (`staticCall`)
Before broadcasting any transaction to the network, the exact packed multi-hop path is executed on-chain via `staticCall`:
```solidity
router.exactInput.staticCall({
    path: executionPath,
    recipient: signer.address,
    deadline: deadline,
    amountIn: tradeAmountWei,
    amountOutMinimum: tradeAmountWei + 1n
});
```
If the trade yields $\le \text{amountIn}$, or if slippage occurs across pool ticks, the call reverts locally. **Zero gas is broadcast.**

### Invariant 3: Core Reserve Protection
The tokens `GMAI`, `RIDE`, `SVM`, and `BANDIQ` are registered in `STRICT_EXCLUSIONS`. The bot will never liquidate, trade away, or deploy these holdings for scalping.

### Invariant 4: Cross-Process Concurrency & Nonce Mutex
To enable running all 3 terminal windows concurrently without `NONCE_EXPIRED` or `REPLACEMENT_UNDERPRICED` errors:
* `scripts/wallet_helper.js` manages per-wallet JSON locks (`data/wallet_locks/`).
* Locks acquire an exclusive file lock, fetch $\max(\text{latestNonce}, \text{pendingNonce})$, and release immediately upon confirmation.

---

## 3. Mathematical Profit Optimization (Window 2)

In `scripts/hyper_growth_engine.js`, pool depth and fee tiers are categorized dynamically:
* **Mega-Whale Pools ($\ge 2,500$ SDA Depth)**: Grid search up to 100.0 SDA.
* **Deep Pools ($\ge 500$ SDA Depth)**: Grid search up to 50.0 SDA.
* **Agile Scalp Pools ($< 500$ SDA Depth)**: Grid search up to 10.0 SDA.

For any candidate pair $(Pool_{Buy}, Pool_{Sell})$, net profit is evaluated as:
$$\text{NetProfit}(x) = \text{Quote}(Pool_{Sell}, \text{Quote}(Pool_{Buy}, x)) - x - \text{GasCost}$$

A Golden-Section search ($1/\phi \approx 0.618$) refines the sizing $x$ to find the maximum net profit point where price impact does not exceed the tier's threshold.

---

## 4. Top 20 Gainers & Losers Scalper (Window 3)

In `scripts/toptrader_token_scalper.js`, `scanTopGainersAndLosers` computes the live spot price spread across all multi-pool tokens:
$$\text{Spread}_{\%} = \frac{Price_{Pool B} - Price_{Pool A}}{Price_{Pool A}} \times 100$$

* Tokens with $\text{Spread} \ge 1.0\%$ are classified as **Top Gainers**.
* Routes yielding $\ge +0.0001$ SDA net profit are queued.
* Wallets 11–15 execute in parallel waves, harvesting profit directly back to WSDA.

---

## 5. Liquidity Reinvestment (GMAI Ecosystem Support)

For every profitable trade executed by any squad:
1. **90%** of net profit is auto-unwrapped and retained in the executing wallet as native SDA.
2. **10%** of net profit is routed to `router.exactInputSingle` to buy `GMAI` from the `10000` fee pool (`0x64F21bC91D11531D88A16075d5E961d33f10B6eA`), continuously bolstering token floor price and liquidity backing.
