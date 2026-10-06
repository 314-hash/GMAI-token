# GMAI Token & Swarm Cadence Controller

Autonomous 3:1 Swarm Cadence Continuous Liquidity & Arbitrage Engine for Sidra Chain (EVM Chain ID 97453).

## Features

- **3:1 Buy/Sell Swarm Cadence**: Multi-wallet coordinated swap execution with configurable reserve protection.
- **DEX Arbitrage Engine**: Real-time cross-pool and routing opportunity scanner with automatic profit validation.
- **Mission Control Dashboard**: Web-based real-time control console with Server-Sent Events (SSE) telemetry and wallet balances.
- **Gas & Slippage Protection**: Dry-run simulation mode, configurable max slippage bps, and gas price constraints.
- **Secure Key Management**: Multi-wallet architecture configured entirely through environment variables.

---

## Architecture Overview

- `server.js`: Unified launcher supporting both CLI and Dashboard modes.
- `controller_server.js`: HTTP + SSE Mission Control dashboard backend.
- `loop_3buy_1sell_continuous.js`: Swarm engine logic executing multi-wallet liquidity cycles.
- `engine/arbitrage_gmai_lp.js`: Arbitrage execution engine and profit calculation.
- `config/tokens.json`: Verified token contracts and pool registries on Sidra Chain.
- `public/`: Web dashboard frontend assets (HTML, CSS, JS).

---

## Getting Started

### 1. Prerequisites
- Node.js v18+ 
- npm or bun

### 2. Installation
```bash
npm install
```

### 3. Environment Configuration
Copy the template and configure your parameters:
```bash
cp .env.example .env
```
Edit `.env` with your network RPC and wallet credentials.

> ⚠️ **SECURITY WARNING**: Never commit your `.env` file or share private keys. Keep them protected at all times.

---

## Usage

### Mission Control Dashboard
Launch the web console on `http://localhost:3000`:
```bash
npm run dashboard
# or
npm start
```

### Swarm Bot Modes
- **Dry-run simulation**:
  ```bash
  npm run bot:dry
  ```
- **Live execution**:
  ```bash
  npm run bot:live
  ```

### Arbitrage Engine Modes
- **Dry-run single round**:
  ```bash
  npm run arb:dry
  ```
- **Continuous live execution**:
  ```bash
  npm run arb:live
  ```

---

## License
ISC
