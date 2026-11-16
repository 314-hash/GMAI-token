# ⛅ Cloudflare Serverless Autonomous Trading Fleet (Wrangler Option A)

Deploy your GMAI autonomous trading engine and liquidity flywheel as a **24/7 serverless Cloudflare Worker** using **Wrangler**.

---

## ⚡ Overview & Capabilities

* **24/7 Automated Heartbeat**: Runs every 1 minute via Cloudflare Cron Triggers (`* * * * *`).
* **Cost**: **100% Free** on Cloudflare Workers Free tier (up to 100,000 requests/day) or $5/month on Workers Paid.
* **Zero Infrastructure Overhead**: No local PC or dedicated server needed. Executes across Cloudflare's 330+ global edge data centers.
* **Full Market Coverage**: Scans **44 verified tokens** across **120 Uniswap V3 pools** on Sidra Chain every cycle.
* **Pre-Flight On-Chain Simulation (`staticCall`)**: Zero gas is broadcast if spreads slip or net profit falls below `0.0001` SDA.
* **GMAI Liquidity Flywheel**: Automatically routes 10% of net profit into the GMAI/WSDA pool (`0x64F21bC91D11531D88A16075d5E961d33f10B6eA`).
* **Public REST API & Webhook Trigger**: Query live spreads, trigger manual trades, and inspect portfolio health via HTTP.

---

## 📁 Architecture Files

* **[`wrangler.toml`](../wrangler.toml)**: Worker configuration, cron triggers, environment bindings, and Node.js compatibility flags.
* **[`worker/index.js`](../worker/index.js)**: Main serverless entrypoint handling both `scheduled` (cron) and `fetch` (HTTP API) events.
* **[`worker/v3_math.js`](../worker/v3_math.js)**: High-speed pure `BigInt` Uniswap-V3 mathematical quoter optimized for V8 isolates.
* **[`worker/tokens.js`](../worker/tokens.js)**: Registry of all 44 tokens and 120 pools on Sidra Chain.

---

## 🚀 Deployment Guide (Step-by-Step)

### 1. Authenticate with Cloudflare
If you haven't logged into Cloudflare CLI on your computer:
```powershell
npx wrangler login
```
*(This opens a browser tab to authorize Wrangler with your free or paid Cloudflare account).*

### 2. Configure Encrypted Secrets
Never put private keys in files. Inject them securely into Cloudflare's encrypted vault:
```powershell
# Set your primary trading wallet private key
npx wrangler secret put PRIVATE_KEY_1

# (Optional) Flip live execution on
npx wrangler secret put LIVE_EXECUTION
# When prompted, enter: true
```

### 3. Test Locally Before Deploying
Run the local emulation server to test the endpoints and market scanner:
```powershell
npm run worker:dev
```
Test the endpoints in your browser or terminal:
* `http://localhost:8787/` — Service health & API guide
* `http://localhost:8787/scan` — Real-time spread scanner across all 44 tokens
* `http://localhost:8787/status` — Current block & scan telemetry

### 4. Deploy Live to Cloudflare Edge
```powershell
npm run worker:deploy
```
Wrangler will output your live URL (e.g., `https://gmai-autonomous-fleet.<your-subdomain>.workers.dev`).

### 5. Stream Live 24/7 Logs
To watch the 1-minute heartbeat trades and live block logs in real time:
```powershell
npm run worker:tail
```

---

## 🌐 HTTP Endpoints Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` or `/health` | Service status, current block height, and configuration overview. |
| `GET` | `/status` | Telemetry from the most recent 1-minute execution cycle. |
| `GET` | `/scan` | Real-time on-chain scan of all 44 tokens and current profit opportunities. |
| `GET` | `/portfolio` | Live balances of Native SDA, WSDA, and GMAI across configured fleet wallets. |
| `POST` | `/trigger` | Manually triggers an immediate scan and on-chain execution cycle. |

---

## 🛡️ Security & Zero-Holding Guarantee

1. **Private Keys Never Stored in Code**: Keys are encrypted at rest using Cloudflare's secret store (`env.PRIVATE_KEY_1`).
2. **Atomic Execution**: Every cycle executes `WSDA ➔ Token ➔ WSDA` in a single transaction with `amountOutMinimum >= amountIn + 1n`. 
3. **Zero Tokens Held**: Capital always returns directly to liquid WSDA/SDA upon confirmation.
