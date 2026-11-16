# GMAI Token & 15-Wallet Autonomous Trading Fleet

[![Sidra Chain](https://img.shields.io/badge/Network-Sidra%20Chain%20(97453)-00C853?style=for-the-badge&logo=ethereum)](https://ledger.sidrachain.com)
[![DEX](https://img.shields.io/badge/DEX-Pinetswap%20Uniswap--V3-FF007A?style=for-the-badge)](https://ledger.sidrachain.com/address/0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb)
[![Architecture](https://img.shields.io/badge/Fleet-15%20Wallets%20Parallel-0052FF?style=for-the-badge)](https://github.com/314-hash/GMAI-token)
[![License](https://img.shields.io/badge/License-ISC-blue?style=for-the-badge)](LICENSE)

High-performance, multi-threaded autonomous algorithmic trading engine and liquidity infrastructure designed for the **Sidra Chain (Chain ID: `97453`)** and **Pinetswap Uniswap-V3 DEX** ecosystem.

The system orchestrates a synchronized **15-wallet autonomous fleet**, dynamically split into specialized operational squads for whale copy trading, multi-tier cross-pool arbitrage, and top gainers/losers combination scalping.

---

## ⚡ Core Architecture: 3 Operational Windows

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                             GMAI MEGA-FLEET TRADING INFRASTRUCTURE                               │
└─────────────────────────────────┬────────────────────────────────┬───────────────────────────────┘
                                  │                                │
         ┌────────────────────────┴──────────────┐                 │
         ▼                                       ▼                 ▼
   WINDOW 1: SQUAD 1                       WINDOW 2: SQUAD 2      WINDOW 3: SQUAD 3
  👑 WHALE COPY TRADER                    📈 HYPER ARBITRAGE     ⚡ GAINERS & LOSERS SCALPER
  Wallets 1 – 5                           Wallets 6 – 10         Wallets 11 – 15
  Working Capital: 100 WSDA each          Capital: 10 WSDA each  Capital: 5 WSDA each
  Deployment: 3.0 to 100.0 SDA            Deployment: 3 to 100   Deployment: 0.5 to 1.5 SDA
  Mempool Whale Reaction                  Cross-Pool Spreads     Top 20 Gainers & Losers
```

### 1. Window 1: Pinetswap Top-Trader Copy Trader (`scripts/copy_trader_pinetswap.js`)
* **Fleet Target**: Wallets 1 to 5 (`--wallet=1-5`).
* **Whale Capital Capacity**: Pre-funded with **100.00 WSDA** base working capital per wallet.
* **Dynamic Sizing**: Strictly clamped between **3.0 SDA minimum** and **100.0 SDA maximum**.
* **Whale Target Tracking**: Listens on live blocks and mempool across 17 verified top-trader whale addresses on Pinetswap.
* **Zero-Holding Invariant**: Rejects non-WSDA directional trades and buys lacking an immediate profitable cross-pool exit before any gas or wrapping occurs. 100% atomic return to WSDA.
* **Profit Allocation**: 90% net profit harvested to Native SDA in wallet, 10% auto-injected into the GMAI/WSDA liquidity pool.

### 2. Window 2: Hyper-Growth Dynamic Arbitrage Engine (`scripts/hyper_growth_engine.js`)
* **Fleet Target**: Wallets 6 to 10 (`--wallet=6-10`).
* **Multi-Tier Liquidity Categorization**:
  * **Mega-Whale Pools (≥ 2,500 SDA Depth)**: 5.0 to 100.0 SDA execution sizing.
  * **Deep Pools (≥ 500 SDA Depth)**: 3.0 to 50.0 SDA execution sizing.
  * **Agile Scalp Pools (< 500 SDA Depth)**: 3.0 to 10.0 SDA execution sizing.
* **Sub-Second Tick Scanner**: Mathematical optimization using Golden-Section search to find the optimal trade size yielding maximum net profit above gas and pool fees.
* **Adaptive Cooldown**: Dynamic 30-second multi-tick cooldown preventing transient slippage from freezing profitable routes.

### 3. Window 3: Top 20 Gainers & Losers Scalper (`scripts/toptrader_token_scalper.js`)
* **Fleet Target**: Wallets 11 to 15 (`--wallet=11-15`).
* **Dynamic Market Scanner**: Scans all **44 verified tokens** across **120 Uniswap V3 pools** on Sidra Chain every cycle.
* **Momentum & Volatility Exploitation**: Automatically detects cross-pool fee spreads (500 ➔ 3000, 3000 ➔ 10000) on active market gainers (e.g., `ATES`, `FBAY`, `BCS`, `SUBV`, `VPE`, `SDO`, `CSF`, `JSFT`).
* **Fleet Rotation & Parallel Execution**: Dispatches 5 wallets in parallel waves with cross-window file locks to prevent nonce collisions.

---

## 🛡️ Risk Controls & Invariants

1. **Zero Tokens Held Guarantee**: Every trade executed by the fleet is an **atomic round-trip (`WSDA ➔ Token ➔ WSDA`)**. Wallets never hold speculative tokens; 100% of capital returns to liquid WSDA/SDA upon confirmation.
2. **Protected Personal Holdings**: Core tokens (`GMAI`, `RIDE`, `SVM`, `BANDIQ`) are isolated and strictly excluded from liquidation or unauthorized swaps.
3. **Pre-Flight On-Chain Simulation (`staticCall`)**: All routes are simulated on-chain via `Router.exactInput.staticCall` with `amountOutMinimum >= amountIn + 1n`. If profit is non-positive or ticks have moved, the transaction aborts with **0 gas spent**.
4. **Cross-Process Mutex Locks (`scripts/wallet_helper.js`)**: File-based wallet locking coordinates transaction nonces across multiple terminal windows, preventing `REPLACEMENT_UNDERPRICED` or out-of-order execution errors.
5. **GMAI Liquidity Injection**: 10% of all net SDA profit is automatically swapped into GMAI and injected into the primary liquidity pool (`0x64F21bC91D11531D88A16075d5E961d33f10B6eA`), continuously expanding token backing.

---

## 🚀 Quick Start Guide

### 1. Installation

```bash
git clone https://github.com/314-hash/GMAI-token.git
cd GMAI-token
npm install
```

### 2. Configure Environment

Copy the configuration template:
```bash
cp .env.example .env
```

Configure your credentials in `.env`:
```ini
RPC_URL=https://rpc.sidrachain.com
CHAIN_ID=97453
ROUTER_ADDRESS=0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb
WSDA_ADDRESS=0xE4095a910209D7BE03B55D02F40d4554B1666182
TARGET_TOKEN_ADDRESS=0x4765561e63914E72168bBd2A7e2ce72F9057ca04
POOL_FEE=10000

# Private Keys (Wallets 1 to 15)
PRIVATE_KEY_1=0x...
PRIVATE_KEY_2=0x...
...
PRIVATE_KEY_15=0x...
```

### 3. Initialize Fleet Working Capital

To establish base working reserves (100 WSDA for W1–5, 10 WSDA for W6–10, 5 WSDA for W11–15):
```powershell
node .\scripts\rebalance_and_wrap_fleet.js
```

---

## 💻 Running the Fleet

Open **3 separate terminal windows** to run the fleet simultaneously:

### Window 1: Whale Copy Trader (Wallets 1 to 5)
```powershell
node .\scripts\copy_trader_pinetswap.js --wallet=1-5 --execute --trade-size=50.0 --same-trade
```

### Window 2: Hyper Arbitrage Engine (Wallets 6 to 10)
```powershell
node .\scripts\hyper_growth_engine.js --wallet=6-10 --execute --min-profit=0.0001
```

### Window 3: Top 20 Gainers & Losers Scalper (Wallets 11 to 15)
```powershell
node .\scripts\toptrader_token_scalper.js --wallet=11-15 --execute --amount=1.5
```

---

## 📊 Mission Control Dashboard

Launch the local real-time web telemetry dashboard:
```powershell
node .\controller_server.js
```
Open [http://localhost:3000](http://localhost:3000) to monitor live balances, transaction hashes, pool reserves, and realized profits.

---

## 🗂️ Ecosystem Token Registry

The fleet scans and trades across **44 verified tokens** and **120 Uniswap-V3 pools** on Sidra Chain, defined in [`config/tokens.json`](config/tokens.json):

| Category | Tokens |
| :--- | :--- |
| **Protected Core Assets** | `GMAI`, `RIDE`, `SVM`, `BANDIQ` |
| **Top Scalping Targets** | `ATES`, `FBAY`, `BCS`, `SUBV`, `VPE`, `SDO`, `CSF`, `JSFT`, `PINE`, `STSX`, `WPX`, `SKMH` |
| **Ecosystem Liquidity** | `FREEt`, `SMAf`, `SDS`, `GLNs`, `VPA`, `ARMS`, `HEC`, `ZSM`, `AIR`, `SIT`, `LNH`, `DBN`, `TKWF`, `TAMBN`, `GACP`, `QSM`, `SMRX`, `DAN`, `IDM`, `MBF`, `AITT`, `AMHS`, `BINV`, `SSMI`, `HAQ`, `DMCS`, `SDIP`, `DIIGE` |

---

## 📄 Contract Addresses (Sidra Chain - 97453)

* **Pinetswap Router (V3)**: [`0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb`](https://ledger.sidrachain.com/address/0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb)
* **Pinetswap Factory (V3)**: [`0xCFE41fb5dA87916D84E7F22889087b4Ff7163cDE`](https://ledger.sidrachain.com/address/0xCFE41fb5dA87916D84E7F22889087b4Ff7163cDE)
* **Wrapped SDA (WSDA)**: [`0xE4095a910209D7BE03B55D02F40d4554B1666182`](https://ledger.sidrachain.com/address/0xE4095a910209D7BE03B55D02F40d4554B1666182)
* **GMAI Token**: [`0x4765561e63914E72168bBd2A7e2ce72F9057ca04`](https://ledger.sidrachain.com/address/0x4765561e63914E72168bBd2A7e2ce72F9057ca04)
* **GMAI / WSDA Primary Pool**: [`0x64F21bC91D11531D88A16075d5E961d33f10B6eA`](https://ledger.sidrachain.com/address/0x64F21bC91D11531D88A16075d5E961d33f10B6eA)

---

## ⚖️ License

ISC License. See [LICENSE](LICENSE) for details.
