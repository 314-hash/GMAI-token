/* ============================================================
   SWARM CADENCE CONTROLLER CLIENT SCRIPT
============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");
  const btnTriggerManual = document.getElementById("btnTriggerManual");
  const btnEmergencyStop = document.getElementById("btnEmergencyStop");
  const btnLoadPreset = document.getElementById("btnLoadPreset");
  const btnRefreshAll = document.getElementById("btnRefreshAll");
  const btnRefreshWallets = document.getElementById("btnRefreshWallets");
  const btnApplyConfig = document.getElementById("btnApplyConfig");
  const btnCopyCli = document.getElementById("btnCopyCli");
  const btnClearTerminal = document.getElementById("btnClearTerminal");
  const btnCopyLogs = document.getElementById("btnCopyLogs");
  const btnAutoScroll = document.getElementById("btnAutoScroll");

  // Form Inputs
  const inputIsLive = document.getElementById("inputIsLive");
  const inputTradeSize = document.getElementById("inputTradeSize");
  const inputRefundRatio = document.getElementById("inputRefundRatio");
  const inputRounds = document.getElementById("inputRounds");
  const inputBuys = document.getElementById("inputBuys");
  const inputDelay = document.getElementById("inputDelay");
  const inputWalletDelay = document.getElementById("inputWalletDelay");
  const inputInterval = document.getElementById("inputInterval");
  const inputMinReserve = document.getElementById("inputMinReserve");
  const inputSlippage = document.getElementById("inputSlippage");

  // Status & Telemetry Displays
  const engineStatusPill = document.getElementById("engineStatusPill");
  const engineStatusLed = document.getElementById("engineStatusLed");
  const engineStatusText = document.getElementById("engineStatusText");
  const modePill = document.getElementById("modePill");
  const modeIcon = document.getElementById("modeIcon");
  const modeText = document.getElementById("modeText");
  const targetAssetDisplay = document.getElementById("targetAssetDisplay");
  const targetTokenAddrDisplay = document.getElementById("targetTokenAddrDisplay");
  const poolAddrDisplay = document.getElementById("poolAddrDisplay");
  const spotPriceDisplay = document.getElementById("spotPriceDisplay");
  const inversePriceDisplay = document.getElementById("inversePriceDisplay");
  const cliCommandPreview = document.getElementById("cliCommandPreview");
  const refundRatioPercent = document.getElementById("refundRatioPercent");

  // HUD
  const statRoundDisplay = document.getElementById("statRoundDisplay");
  const statRoundSub = document.getElementById("statRoundSub");
  const statOrdersDisplay = document.getElementById("statOrdersDisplay");
  const statSpentDisplay = document.getElementById("statSpentDisplay");
  const statRefundedDisplay = document.getElementById("statRefundedDisplay");
  const statNetCostDisplay = document.getElementById("statNetCostDisplay");
  const statRecoveryRateDisplay = document.getElementById("statRecoveryRateDisplay");
  const hudStatusBadge = document.getElementById("hudStatusBadge");

  // Math Explainer
  const mathBuySize = document.getElementById("mathBuySize");
  const mathGrossSpend = document.getElementById("mathGrossSpend");
  const mathGrossSpend2 = document.getElementById("mathGrossSpend2");
  const mathRatio = document.getElementById("mathRatio");
  const mathRefund = document.getElementById("mathRefund");
  const mathNet = document.getElementById("mathNet");
  const mathToken = document.getElementById("mathToken");

  // Wallets & Terminal
  const walletsContainer = document.getElementById("walletsContainer");
  const terminalWindow = document.getElementById("terminalWindow");
  const filterBtns = document.querySelectorAll(".filter-btn");

  let isAutoScroll = true;
  let activeLogFilter = "all";
  let logsStore = [];
  let sseSource = null;

  // Notification Toast
  function showToast(message, type = "success") {
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3500);
  }

  // Update Dynamic Math Explainer & CLI Preview
  function updateMathAndCliPreview() {
    const tradeSize = parseFloat(inputTradeSize.value) || 0.03;
    const refundRatio = parseFloat(inputRefundRatio.value) || 0.80;
    const buys = parseInt(inputBuys.value, 10) || 3;
    const rounds = parseInt(inputRounds.value, 10) || 0;
    const isLive = inputIsLive.checked;
    const delay = parseInt(inputDelay.value, 10) || 3000;
    const walletDelay = parseInt(inputWalletDelay?.value, 10) || 30;
    const interval = parseInt(inputInterval.value, 10) || 60000;

    // Math calculation
    const grossPerWallet = tradeSize * buys;
    const refundPerWallet = grossPerWallet * refundRatio;
    const netPerWallet = grossPerWallet - refundPerWallet;
    const tokenSymbol = targetAssetDisplay.textContent.split(" ")[0] || "GMAI";

    mathBuySize.textContent = tradeSize.toFixed(4);
    mathGrossSpend.textContent = grossPerWallet.toFixed(4) + " SDA";
    mathGrossSpend2.textContent = grossPerWallet.toFixed(4) + " SDA";
    mathRatio.textContent = Math.round(refundRatio * 100) + "%";
    mathRefund.textContent = refundPerWallet.toFixed(4) + " SDA";
    mathNet.textContent = netPerWallet.toFixed(4) + " SDA";
    mathToken.textContent = tokenSymbol;
    refundRatioPercent.textContent = Math.round(refundRatio * 100) + "%";

    // CLI preview string
    let cmd = `node .\\scripts\\loop_3buy_1sell_continuous.js --trade-size=${tradeSize} --refund-ratio=${refundRatio.toFixed(2)} --rounds=${rounds} --delay=${delay} --wallet-delay=${walletDelay}`;
    if (buys !== 3) cmd += ` --buys=${buys}`;
    if (interval !== 60000) cmd += ` --interval=${interval}`;
    if (isLive) cmd += ` --execute`;

    cliCommandPreview.textContent = cmd;

    // Mode Pill
    if (isLive) {
      modePill.className = "status-pill mode-pill mode-live";
      modeIcon.textContent = "🚨";
      modeText.textContent = "LIVE ON-CHAIN";
    } else {
      modePill.className = "status-pill mode-pill mode-dry";
      modeIcon.textContent = "🛡️";
      modeText.textContent = "DRY-RUN SIMULATION";
    }
  }

  // Setup Event Listeners for Live Math Updates
  [inputTradeSize, inputRefundRatio, inputBuys, inputRounds, inputIsLive, inputDelay, inputWalletDelay, inputInterval].forEach(el => {
    if (el) {
      el.addEventListener("input", updateMathAndCliPreview);
      el.addEventListener("change", updateMathAndCliPreview);
    }
  });

  // Preset Button Click
  btnLoadPreset.addEventListener("click", () => {
    inputTradeSize.value = "0.1";
    inputRefundRatio.value = "0.70";
    inputRounds.value = "0";
    inputBuys.value = "3";
    inputIsLive.checked = true;
    inputDelay.value = "30";
    if (inputWalletDelay) inputWalletDelay.value = "30";
    inputInterval.value = "60000";
    inputMinReserve.value = "0.5";
    inputSlippage.value = "100";
    updateMathAndCliPreview();
    showToast("Preset Loaded: 0.1 SDA / 70% Refund / 30s Delays / Live!", "success");
  });

  // Copy CLI command
  btnCopyCli.addEventListener("click", () => {
    navigator.clipboard.writeText(cliCommandPreview.textContent);
    showToast("Copied CLI command to clipboard!", "success");
  });

  // Append Log Line to Terminal
  function appendLog(timestamp, level, message) {
    const logItem = { timestamp, level, message };
    logsStore.push(logItem);
    if (logsStore.length > 500) logsStore.shift();

    const line = document.createElement("div");
    let cssType = "info";
    if (level === "error") cssType = "error";
    else if (level === "warn") cssType = "warn";
    else if (level === "success") cssType = "success";
    else if (message.includes("[🟢 BUY]") || message.includes("BUY Confirmed")) cssType = "buy";
    else if (message.includes("[🔴 SELL]") || message.includes("SELL Confirmed")) cssType = "sell";
    else if (message.includes("ROUND") || message.includes("CONTINUOUS")) cssType = "system";

    line.className = `terminal-line ${cssType}`;
    line.dataset.type = cssType;

    const timeSpan = document.createElement("span");
    timeSpan.className = "term-time";
    timeSpan.textContent = `[${timestamp || new Date().toLocaleTimeString()}]`;

    const textSpan = document.createElement("span");
    textSpan.className = "term-text";
    textSpan.textContent = message;

    line.appendChild(timeSpan);
    line.appendChild(textSpan);

    // Filter check
    if (activeLogFilter !== "all" && cssType !== activeLogFilter) {
      line.style.display = "none";
    }

    terminalWindow.appendChild(line);

    if (isAutoScroll) {
      terminalWindow.scrollTop = terminalWindow.scrollHeight;
    }
  }

  // Terminal Filters
  filterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      filterBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeLogFilter = btn.dataset.filter;

      const lines = terminalWindow.querySelectorAll(".terminal-line");
      lines.forEach(l => {
        if (activeLogFilter === "all") {
          l.style.display = "flex";
        } else if (l.dataset.type === activeLogFilter) {
          l.style.display = "flex";
        } else {
          l.style.display = "none";
        }
      });
    });
  });

  btnClearTerminal.addEventListener("click", () => {
    terminalWindow.innerHTML = "";
    logsStore = [];
    showToast("Terminal logs cleared", "info");
  });

  btnCopyLogs.addEventListener("click", () => {
    const text = logsStore.map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`).join("\n");
    navigator.clipboard.writeText(text);
    showToast("All logs copied to clipboard!", "success");
  });

  btnAutoScroll.addEventListener("click", () => {
    isAutoScroll = !isAutoScroll;
    btnAutoScroll.classList.toggle("active", isAutoScroll);
    btnAutoScroll.textContent = `Auto-scroll: ${isAutoScroll ? "ON" : "OFF"}`;
  });

  // Render Wallets Grid
  function renderWallets(wallets) {
    if (!wallets || !wallets.length) {
      walletsContainer.innerHTML = `<div class="loading-placeholder">No active wallets configured in environment.</div>`;
      return;
    }

    walletsContainer.innerHTML = wallets.map(w => {
      const short = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
      const readyBadge = w.isReady 
        ? `<span class="wallet-badge-ready">READY</span>` 
        : `<span class="wallet-badge-low">LOW RESERVE</span>`;

      return `
        <div class="wallet-card">
          <div class="wallet-info">
            <span class="wallet-tag">${w.key}</span>
            <a href="https://ledger.sidrachain.com/address/${w.address}" target="_blank" rel="noreferrer" class="wallet-address" title="${w.address}">
              ${short} ↗
            </a>
            ${readyBadge}
          </div>
          <div class="wallet-balances">
            <div class="bal-item">
              <span class="bal-label">NATIVE SDA</span>
              <span class="bal-value gold-text">${w.nativeSda.toFixed(4)}</span>
            </div>
            <div class="bal-item">
              <span class="bal-label">WSDA</span>
              <span class="bal-value cyan-text">${w.wsda.toFixed(4)}</span>
            </div>
            <div class="bal-item">
              <span class="bal-label">${w.tokenSymbol || "GMAI"}</span>
              <span class="bal-value emerald-text">${Number(w.token).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  // Update UI with Engine State & Stats
  function updateStateUI(state) {
    if (!state) return;

    // Running State
    const isRunning = state.status === "RUNNING";
    btnStart.disabled = isRunning;
    btnStop.disabled = !isRunning;

    if (isRunning) {
      engineStatusLed.className = "led-dot led-gold";
      engineStatusText.textContent = "CADENCE ACTIVE";
      hudStatusBadge.className = "badge badge-pulse";
      hudStatusBadge.textContent = "RUNNING";
    } else if (state.status === "EMERGENCY_HALTED") {
      engineStatusLed.className = "led-dot led-red";
      engineStatusText.textContent = "EMERGENCY HALT";
      hudStatusBadge.className = "badge";
      hudStatusBadge.textContent = "HALTED";
    } else {
      engineStatusLed.className = "led-dot led-gray";
      engineStatusText.textContent = "IDLE / STOPPED";
      hudStatusBadge.className = "badge";
      hudStatusBadge.textContent = "READY";
    }

    // Config Sync
    if (state.config) {
      targetAssetDisplay.textContent = `${state.config.tokenSymbol || "GMAI"} (GameMind AI)`;
      if (state.config.targetTokenAddress) {
        targetTokenAddrDisplay.textContent = `${state.config.targetTokenAddress.slice(0, 6)}...${state.config.targetTokenAddress.slice(-4)}`;
      }
      if (state.config.poolAddress) {
        poolAddrDisplay.textContent = `${state.config.poolAddress.slice(0, 6)}...${state.config.poolAddress.slice(-4)}`;
      }
      if (state.spotPrice) {
        spotPriceDisplay.textContent = `~${state.spotPrice.toFixed(4)} SDA`;
        const inv = state.spotPrice > 0 ? (1 / state.spotPrice).toFixed(4) : "0";
        inversePriceDisplay.textContent = `1 SDA ≈ ${inv} ${state.config.tokenSymbol || "GMAI"}`;
      }
      if (state.config.walletDelay && inputWalletDelay && document.activeElement !== inputWalletDelay) {
        inputWalletDelay.value = Math.round(state.config.walletDelay / 1000);
      }
    }

    // Stats HUD
    if (state.stats) {
      const s = state.stats;
      statRoundDisplay.textContent = s.currentRound || 0;
      statRoundSub.textContent = state.config?.rounds > 0 ? `Target: ${state.config.rounds} Rounds` : "Continuous Infinite";
      statOrdersDisplay.innerHTML = `${s.totalBuys || 0} <small class="text-muted">/ ${s.totalSells || 0}</small>`;
      statSpentDisplay.innerHTML = `${(s.totalSpentSda || 0).toFixed(4)} <small>SDA</small>`;
      statRefundedDisplay.innerHTML = `${(s.totalRefundedSda || 0).toFixed(4)} <small>SDA</small>`;
      statNetCostDisplay.innerHTML = `${(s.netFuelSpentSda || 0).toFixed(4)} <small>SDA</small>`;
      statRecoveryRateDisplay.textContent = `${(s.recoveryPercent || 80.0).toFixed(1)}%`;
    }

    if (state.wallets) {
      renderWallets(state.wallets);
    }
  }

  // Fetch Full State from Server
  async function fetchState() {
    try {
      const res = await fetch("/api/state");
      if (!res.ok) return;
      const data = await res.json();
      updateStateUI(data);
    } catch (e) {
      console.error("Failed to fetch state:", e);
    }
  }

  // Fetch Wallets
  async function fetchWallets() {
    try {
      const res = await fetch("/api/wallets");
      if (!res.ok) return;
      const data = await res.json();
      renderWallets(data.wallets);
      showToast("Synced on-chain wallet balances", "success");
    } catch (e) {
      showToast("Error syncing wallet balances", "danger");
    }
  }

  // Connect Server-Sent Events (SSE)
  function initSSE() {
    if (sseSource) sseSource.close();
    sseSource = new EventSource("/api/events");

    sseSource.onopen = () => {
      console.log("[SSE] Connected to Swarm Mission Control daemon");
    };

    sseSource.addEventListener("log", (e) => {
      try {
        const item = JSON.parse(e.data);
        appendLog(item.timestamp, item.level, item.message);
      } catch (err) {}
    });

    sseSource.addEventListener("status", (e) => {
      try {
        const item = JSON.parse(e.data);
        fetchState();
      } catch (err) {}
    });

    sseSource.addEventListener("stats", (e) => {
      try {
        const item = JSON.parse(e.data);
        if (statOrdersDisplay) {
          statOrdersDisplay.innerHTML = `${item.totalBuys || 0} <small class="text-muted">/ ${item.totalSells || 0}</small>`;
          statSpentDisplay.innerHTML = `${(item.totalSpentSda || 0).toFixed(4)} <small>SDA</small>`;
          statRefundedDisplay.innerHTML = `${(item.totalRefundedSda || 0).toFixed(4)} <small>SDA</small>`;
          statNetCostDisplay.innerHTML = `${(item.netFuelSpentSda || 0).toFixed(4)} <small>SDA</small>`;
        }
      } catch (err) {}
    });

    sseSource.onerror = () => {
      setTimeout(initSSE, 5000);
    };
  }

  // Button Actions: Start
  btnStart.addEventListener("click", async () => {
    const delayVal = parseInt(inputDelay.value, 10) || 30;
    const walletDelayVal = parseInt(inputWalletDelay?.value, 10) || 30;
    const payload = {
      tradeSize: parseFloat(inputTradeSize.value) || 0.1,
      refundRatio: parseFloat(inputRefundRatio.value) || 0.70,
      rounds: parseInt(inputRounds.value, 10) || 0,
      buys: parseInt(inputBuys.value, 10) || 3,
      delay: delayVal <= 600 ? delayVal * 1000 : delayVal,
      walletDelay: walletDelayVal <= 600 ? walletDelayVal * 1000 : walletDelayVal,
      interval: parseInt(inputInterval.value, 10) || 60000,
      minReserve: parseFloat(inputMinReserve.value) || 0.5,
      maxSlippageBps: parseInt(inputSlippage.value, 10) || 100,
      isLive: inputIsLive.checked
    };

    try {
      btnStart.disabled = true;
      const res = await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        showToast("Swarm Cadence Started!", "success");
        fetchState();
      } else {
        showToast(data.error || "Failed to start", "danger");
        btnStart.disabled = false;
      }
    } catch (e) {
      showToast(e.message, "danger");
      btnStart.disabled = false;
    }
  });

  // Button Actions: Stop
  btnStop.addEventListener("click", async () => {
    try {
      btnStop.disabled = true;
      const res = await fetch("/api/stop", { method: "POST" });
      const data = await res.json();
      showToast("Stop signal sent. Completing round safely...", "warning");
      fetchState();
    } catch (e) {
      showToast(e.message, "danger");
    }
  });

  // Button Actions: Emergency Stop
  btnEmergencyStop.addEventListener("click", async () => {
    if (!confirm("🚨 Are you sure you want to FORCE EMERGENCY STOP the swarm engine? All active loops will be terminated immediately.")) {
      return;
    }
    try {
      const res = await fetch("/api/emergency-stop", { method: "POST" });
      const data = await res.json();
      showToast("🚨 EMERGENCY STOP EXECUTED!", "danger");
      fetchState();
    } catch (e) {
      showToast(e.message, "danger");
    }
  });

  // Button Actions: Trigger 1 Round
  btnTriggerManual.addEventListener("click", async () => {
    try {
      btnTriggerManual.disabled = true;
      showToast("Executing single 3:1 cadence round...", "info");
      const res = await fetch("/api/trigger-round", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        showToast("Manual round triggered successfully!", "success");
      } else {
        showToast(data.error || "Manual round failed", "danger");
      }
      btnTriggerManual.disabled = false;
      fetchState();
    } catch (e) {
      showToast(e.message, "danger");
      btnTriggerManual.disabled = false;
    }
  });

  // Apply Config Updates
  btnApplyConfig.addEventListener("click", async (e) => {
    e.preventDefault();
    const delayVal = parseInt(inputDelay.value, 10) || 30;
    const walletDelayVal = parseInt(inputWalletDelay?.value, 10) || 30;
    const payload = {
      tradeSize: parseFloat(inputTradeSize.value) || 0.1,
      refundRatio: parseFloat(inputRefundRatio.value) || 0.70,
      rounds: parseInt(inputRounds.value, 10) || 0,
      buys: parseInt(inputBuys.value, 10) || 3,
      delay: delayVal <= 600 ? delayVal * 1000 : delayVal,
      walletDelay: walletDelayVal <= 600 ? walletDelayVal * 1000 : walletDelayVal,
      interval: parseInt(inputInterval.value, 10) || 60000,
      minReserve: parseFloat(inputMinReserve.value) || 0.5,
      isLive: inputIsLive.checked
    };

    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        showToast("Swarm parameters updated successfully!", "success");
        updateMathAndCliPreview();
      } else {
        showToast(data.error || "Failed to update config", "danger");
      }
    } catch (err) {
      showToast(err.message, "danger");
    }
  });

  btnRefreshAll.addEventListener("click", () => {
    fetchState();
    fetchWallets();
    showToast("Synced live data from blockchain", "success");
  });

  btnRefreshWallets.addEventListener("click", fetchWallets);

  /* ============================================================
     42-TOKEN ARBITRAGE & GMAI LP CONTROLLER
  ============================================================ */
  const btnArbScan = document.getElementById("btnArbScan");
  const btnArbStart = document.getElementById("btnArbStart");
  const btnArbStop = document.getElementById("btnArbStop");
  const arbStatusPill = document.getElementById("arbStatusPill");
  const arbStatusLed = document.getElementById("arbStatusLed");
  const arbStatusText = document.getElementById("arbStatusText");

  const arbTotalProfitDisplay = document.getElementById("arbTotalProfitDisplay");
  const arbTradesCountDisplay = document.getElementById("arbTradesCountDisplay");
  const arbSdaBankedDisplay = document.getElementById("arbSdaBankedDisplay");
  const arbGmaiInjectedDisplay = document.getElementById("arbGmaiInjectedDisplay");
  const arbGmaiAcquiredDisplay = document.getElementById("arbGmaiAcquiredDisplay");
  const arbOppsCountDisplay = document.getElementById("arbOppsCountDisplay");
  const arbTokensCountDisplay = document.getElementById("arbTokensCountDisplay");
  const arbScanTimeDisplay = document.getElementById("arbScanTimeDisplay");
  const arbTableBody = document.getElementById("arbTableBody");

  function renderArbitrageTable(opps) {
    if (!arbTableBody) return;
    if (!opps || opps.length === 0) {
      arbTableBody.innerHTML = `<tr><td colspan="9" class="text-center text-muted">No profitable spreads >= threshold found in current scan. Pools are in balance.</td></tr>`;
      return;
    }

    // Sort by net profit descending
    const sorted = [...opps].sort((a, b) => b.netProfitSda - a.netProfitSda);

    arbTableBody.innerHTML = sorted.slice(0, 15).map(o => {
      const grossStr = `+${o.grossProfitSda.toFixed(5)} SDA`;
      const netStr = `+${o.netProfitSda.toFixed(5)} SDA`;
      const roiStr = `+${o.roiPct.toFixed(2)}%`;
      const impactStr = `${o.priceImpactPct.toFixed(2)}%`;

      return `
        <tr>
          <td><strong>${o.token}</strong></td>
          <td><span class="tier-badge tier-${o.feeBuy}">Fee ${o.feeBuy}</span></td>
          <td><span class="tier-badge tier-${o.feeSell}">Fee ${o.feeSell}</span></td>
          <td class="gold-text">${o.inputSda} SDA</td>
          <td>${grossStr}</td>
          <td><span class="arb-profit-badge">${netStr}</span></td>
          <td class="emerald-text">${roiStr}</td>
          <td>${impactStr}</td>
          <td><span class="wallet-badge-ready">PROFITABLE</span></td>
        </tr>
      `;
    }).join("");
  }

  function updateArbStateUI(state) {
    if (!state) return;

    const stats = state.stats || {};
    const isRunning = stats.isRunning;
    const isScanning = stats.isExecutingScan;

    if (btnArbStart) btnArbStart.disabled = isRunning || isScanning;
    if (btnArbStop) btnArbStop.disabled = !isRunning;
    if (btnArbScan) btnArbScan.disabled = isScanning;

    if (isRunning) {
      if (arbStatusLed) arbStatusLed.className = "led-dot led-gold";
      if (arbStatusText) arbStatusText.textContent = "ARB ACTIVE";
    } else if (isScanning) {
      if (arbStatusLed) arbStatusLed.className = "led-dot led-cyan";
      if (arbStatusText) arbStatusText.textContent = "SCANNING POOLS...";
    } else {
      if (arbStatusLed) arbStatusLed.className = "led-dot led-gray";
      if (arbStatusText) arbStatusText.textContent = "ARB IDLE";
    }

    if (arbTotalProfitDisplay) arbTotalProfitDisplay.innerHTML = `+${(stats.netProfitSda || 0).toFixed(5)} <small>SDA</small>`;
    if (arbTradesCountDisplay) arbTradesCountDisplay.textContent = `${stats.tradesExecuted || 0} Trades Executed (${stats.roundsScanned || 0} Rounds)`;
    if (arbSdaBankedDisplay) arbSdaBankedDisplay.innerHTML = `+${(stats.accumulatedNativeSda || 0).toFixed(5)} <small>SDA</small>`;
    if (arbGmaiInjectedDisplay) arbGmaiInjectedDisplay.innerHTML = `+${(stats.gmaiLiquidityInjectedSda || 0).toFixed(5)} <small>WSDA</small>`;
    if (arbGmaiAcquiredDisplay) arbGmaiAcquiredDisplay.textContent = `+${(stats.gmaiTokensAcquired || 0).toFixed(2)} GMAI Bought into Pool`;

    if (state.opportunities) {
      const uniqueTokens = new Set(state.opportunities.map(o => o.token)).size;
      if (arbOppsCountDisplay) arbOppsCountDisplay.innerHTML = `${state.opportunities.length} <small>Routes</small>`;
      if (arbTokensCountDisplay) arbTokensCountDisplay.textContent = `Across ${uniqueTokens} Unique Token(s)`;
      renderArbitrageTable(state.opportunities);
    }

    if (stats.lastScanTime && arbScanTimeDisplay) {
      const timeStr = new Date(stats.lastScanTime).toLocaleTimeString();
      arbScanTimeDisplay.textContent = `Last Scan: ${timeStr}`;
    }
  }

  async function fetchArbState() {
    try {
      const res = await fetch("/api/arb/state");
      if (!res.ok) return;
      const data = await res.json();
      updateArbStateUI(data);
    } catch (e) {
      console.error("Failed to fetch arb state:", e);
    }
  }

  if (btnArbStart) {
    btnArbStart.addEventListener("click", async () => {
      try {
        btnArbStart.disabled = true;
        const res = await fetch("/api/arb/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isLive: inputIsLive.checked, gmaiProfitRatio: 0.40 })
        });
        const data = await res.json();
        if (res.ok) {
          showToast("42-Token Arbitrage & GMAI LP Engine Launched!", "success");
          fetchArbState();
        } else {
          showToast(data.error || "Failed to start arb", "danger");
          btnArbStart.disabled = false;
        }
      } catch (err) {
        showToast(err.message, "danger");
        btnArbStart.disabled = false;
      }
    });
  }

  if (btnArbStop) {
    btnArbStop.addEventListener("click", async () => {
      try {
        btnArbStop.disabled = true;
        const res = await fetch("/api/arb/stop", { method: "POST" });
        const data = await res.json();
        if (res.ok) {
          showToast("Arbitrage stop signaled", "warning");
          fetchArbState();
        } else {
          showToast(data.error || "Failed to stop arb", "danger");
        }
      } catch (err) {
        showToast(err.message, "danger");
      }
    });
  }

  if (btnArbScan) {
    btnArbScan.addEventListener("click", async () => {
      try {
        btnArbScan.disabled = true;
        showToast("Scanning 42 tokens across all pool tiers...", "info");
        const res = await fetch("/api/arb/scan", { method: "POST" });
        const data = await res.json();
        if (res.ok) {
          showToast("Market scan initiated!", "success");
        } else {
          showToast(data.error || "Scan failed", "danger");
        }
        setTimeout(fetchArbState, 8000);
      } catch (err) {
        showToast(err.message, "danger");
        btnArbScan.disabled = false;
      }
    });
  }

  // Hook SSE Events for Arbitrage
  if (sseSource) {
    sseSource.addEventListener("arb_log", (e) => {
      try {
        const item = JSON.parse(e.data);
        appendLog(item.timestamp, item.level, `[ARB] ${item.message}`);
      } catch (err) {}
    });

    sseSource.addEventListener("arb_stats", (e) => {
      try {
        const item = JSON.parse(e.data);
        updateArbStateUI({ stats: item });
      } catch (err) {}
    });

    sseSource.addEventListener("arb_opportunities", (e) => {
      try {
        const opps = JSON.parse(e.data);
        renderArbitrageTable(opps);
      } catch (err) {}
    });

    sseSource.addEventListener("arb_trade_executed", (e) => {
      try {
        const item = JSON.parse(e.data);
        showToast(`Arb Executed on ${item.token}! 40% routed to GMAI LP`, "success");
        fetchArbState();
        fetchWallets();
      } catch (err) {}
    });
  }

  // Initialize
  updateMathAndCliPreview();
  initSSE();
  fetchState();
  fetchArbState();

  // Auto-refresh wallets and arb state every 20 seconds
  setInterval(() => {
    fetchState();
    fetchArbState();
  }, 20000);
});

