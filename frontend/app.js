// frontend/app.js

const CONTRACT_ADDRESS = "your contract address";
const EXPECTED_CHAIN_ID = 11155111; // Sepolia
const SEPOLIA_RPC = "https://rpc.sepolia.org";

let provider = null;
let signer = null;
let contract = null;
let readContract = null; // read-only for non-connected users
let contractAbi = null;
let userAddress = null;
let roundData = null;
let voterCounts = [];
let refreshInterval = null;
let timerInterval = null;
let endTimeCache = 0;
let currentRoundId = 0;
let userVotedOption = 0;
let resultShown = false;
let isProcessing = false; // prevent double-clicks

const OPTION_COLORS = [
    "#6c5ce7", "#00b894", "#e17055", "#fdcb6e",
    "#a29bfe", "#74b9ff", "#fd79a8", "#55efc4",
    "#fab1a0", "#81ecec"
];

const OPTION_LABELS = [
    "Alpha", "Beta", "Gamma", "Delta",
    "Epsilon", "Zeta", "Eta", "Theta",
    "Iota", "Kappa"
];

// ── INIT ──
document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("connectBtn").addEventListener("click", connectWallet);
    document.getElementById("claimBtn")?.addEventListener("click", claimReward);
    document.getElementById("winClaimBtn")?.addEventListener("click", claimReward);

    try {
        const resp = await fetch("abi.json");
        contractAbi = await resp.json();
        log("ABI loaded.", "info");
    } catch {
        log("Could not load abi.json.", "error");
        return;
    }

    // Load read-only data even without wallet
    await initReadOnly();

    // Auto-connect if previously connected
    if (typeof window.ethereum !== "undefined") {
        const accounts = await window.ethereum.request({ method: "eth_accounts" });
        if (accounts.length > 0) await connectWallet();
    }
});

// ── READ-ONLY INIT (works without MetaMask) ──
async function initReadOnly() {
    try {
        const readProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
        readContract = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, readProvider);

        const link = document.getElementById("contractLink");
        link.textContent = CONTRACT_ADDRESS.slice(0, 10) + "..." + CONTRACT_ADDRESS.slice(-8);
        link.href = `https://sepolia.etherscan.io/address/${CONTRACT_ADDRESS}`;

        await refreshAll();
        if (refreshInterval) clearInterval(refreshInterval);
        refreshInterval = setInterval(refreshAll, 8000);
        log("Viewing contract (read-only). Connect wallet to vote.", "info");
    } catch (err) {
        log(`Read-only init failed: ${err.message}`, "error");
    }
}

// ── CONNECT ──
async function connectWallet() {
    if (typeof window.ethereum === "undefined") {
        log("MetaMask not detected!", "error");
        alert("Please install MetaMask to participate.\nhttps://metamask.io");
        return;
    }
    try {
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        userAddress = accounts[0];

        const network = await provider.getNetwork();

        document.getElementById("connectBtn").classList.add("hidden");
        document.getElementById("accountInfo").classList.remove("hidden");
        document.getElementById("accountAddress").textContent =
            userAddress.slice(0, 6) + "..." + userAddress.slice(-4);

        if (Number(network.chainId) !== EXPECTED_CHAIN_ID) {
            document.getElementById("networkWarning").classList.remove("hidden");
            log("Wrong network! Attempting to switch to Sepolia...", "warn");
            await switchToSepolia();
            return;
        }

        document.getElementById("networkWarning").classList.add("hidden");
        log(`Connected: ${userAddress.slice(0, 10)}...`, "success");

        // Upgrade to signer-based contract
        contract = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, signer);
        readContract = contract; // use signer contract for reads too

        await refreshAll();

        window.ethereum.on("accountsChanged", () => window.location.reload());
        window.ethereum.on("chainChanged", () => window.location.reload());
    } catch (err) {
        log(`Connection failed: ${err.message}`, "error");
    }
}

// ── AUTO SWITCH NETWORK ──
async function switchToSepolia() {
    try {
        await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0xaa36a7" }], // 11155111 in hex
        });
        window.location.reload();
    } catch (switchError) {
        // Chain not added to MetaMask — add it
        if (switchError.code === 4902) {
            try {
                await window.ethereum.request({
                    method: "wallet_addEthereumChain",
                    params: [{
                        chainId: "0xaa36a7",
                        chainName: "Sepolia Testnet",
                        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                        rpcUrls: ["https://rpc.sepolia.org"],
                        blockExplorerUrls: ["https://sepolia.etherscan.io"]
                    }]
                });
                window.location.reload();
            } catch (addError) {
                log(`Failed to add Sepolia: ${addError.message}`, "error");
            }
        } else {
            log(`Failed to switch network: ${switchError.message}`, "error");
        }
    }
}

// ── REFRESH ALL ──
async function refreshAll() {
    const activeContract = contract || readContract;
    if (!activeContract) return;

    try {
        currentRoundId = Number(await activeContract.currentRoundId());
        if (currentRoundId === 0) {
            log("No round started yet.", "warn");
            document.getElementById("roundBadge").textContent = "No active round";
            return;
        }

        document.getElementById("roundBadge").textContent = `Round #${currentRoundId}`;

        const info = await activeContract.getRoundInfo(currentRoundId);
        const prevState = roundData?.state;

        roundData = {
            state: Number(info[0]),
            pot: info[1],
            endTime: Number(info[2]),
            entryFee: info[3],
            numOptions: Number(info[4]),
            splitAmongAll: info[5],
            totalEntries: Number(info[6]),
            isDrawn: info[7],
            winningOption: Number(info[8]),
        };
        endTimeCache = roundData.endTime;

        // Reset resultShown when new round starts
        if (prevState === 2 && roundData.state === 0) {
            resultShown = false;
            userVotedOption = 0;
        }

        voterCounts = [];
        for (let i = 1; i <= roundData.numOptions; i++) {
            const c = Number(await activeContract.getVoterCount(currentRoundId, i));
            voterCounts.push(c);
        }

        updateStatusDisplay();
        updateDistribution();
        updateOdds();
        updateOptionsGrid();
        updateWinnerSection();
        startTimer();
    } catch (err) {
        log(`Refresh error: ${err.message}`, "error");
    }
}

// ── STATUS DISPLAY ──
function updateStatusDisplay() {
    const stateEl = document.getElementById("stateDisplay");
    const potEl = document.getElementById("potDisplay");
    const entriesEl = document.getElementById("entriesDisplay");
    const feeEl = document.getElementById("feeDisplay");
    const modeEl = document.getElementById("modeDisplay");

    const stateNames = ["OPEN", "CALCULATING", "CLOSED"];
    const badgeClasses = ["badge-open", "badge-calculating", "badge-closed"];
    stateEl.innerHTML = `<span class="badge ${badgeClasses[roundData.state]}">${stateNames[roundData.state]}</span>`;

    const potEth = ethers.formatEther(roundData.pot);
    potEl.textContent = `${parseFloat(potEth).toFixed(4)} ETH`;
    entriesEl.textContent = roundData.totalEntries;

    const feeEth = ethers.formatEther(roundData.entryFee);
    feeEl.textContent = `${feeEth} ETH`;
    modeEl.textContent = roundData.splitAmongAll ? "Split Among All" : "Single Random Winner";
}

// ── VOTE DISTRIBUTION BARS ──
function updateDistribution() {
    const container = document.getElementById("distributionBars");
    container.innerHTML = "";
    const total = roundData.totalEntries || 1;

    for (let i = 0; i < roundData.numOptions; i++) {
        const count = voterCounts[i];
        const pct = ((count / total) * 100).toFixed(1);
        const color = OPTION_COLORS[i % OPTION_COLORS.length];
        const label = OPTION_LABELS[i % OPTION_LABELS.length];

        const row = document.createElement("div");
        row.className = "dist-row";
        row.innerHTML = `
            <div class="dist-label" style="color:${color}">${label}</div>
            <div class="dist-bar-wrap">
                <div class="dist-bar" style="width:${roundData.totalEntries > 0 ? pct : 0}%;background:${color}"></div>
            </div>
            <div class="dist-stats">
                <span class="dist-count">${count}</span>
                <span class="dist-pct">${roundData.totalEntries > 0 ? pct : "0.0"}%</span>
            </div>
        `;
        container.appendChild(row);
    }
}

// ── ODDS & PAYOUTS ──
function updateOdds() {
    const grid = document.getElementById("oddsGrid");
    grid.innerHTML = "";
    const total = roundData.totalEntries;
    const potWei = roundData.pot;

    for (let i = 0; i < roundData.numOptions; i++) {
        const count = voterCounts[i];
        const color = OPTION_COLORS[i % OPTION_COLORS.length];
        const label = OPTION_LABELS[i % OPTION_LABELS.length];

        let coefficient, payoutText, impliedProb;

        if (roundData.splitAmongAll) {
            if (count > 0) {
                coefficient = (total / count).toFixed(2);
                const share = potWei / BigInt(count);
                payoutText = `${parseFloat(ethers.formatEther(share)).toFixed(4)} ETH`;
            } else {
                coefficient = total > 0 ? `${total + 1}.00` : "-.--";
                payoutText = total > 0
                    ? `${parseFloat(ethers.formatEther(potWei + roundData.entryFee)).toFixed(4)} ETH`
                    : "-- ETH";
            }
            impliedProb = total > 0
                ? ((1 / parseFloat(coefficient || total)) * 100).toFixed(1)
                : "--";
        } else {
            if (count > 0) {
                coefficient = (total / count).toFixed(2);
                payoutText = `${parseFloat(ethers.formatEther(potWei)).toFixed(4)} ETH`;
            } else {
                coefficient = total > 0 ? `${total + 1}.00` : "-.--";
                payoutText = `${parseFloat(ethers.formatEther(potWei)).toFixed(4)} ETH`;
            }
            impliedProb = total > 0 && count > 0
                ? ((count / total) * 100).toFixed(1)
                : "--";
        }

        const card = document.createElement("div");
        card.className = "odds-card";
        card.innerHTML = `
            <div class="odds-label" style="border-left:3px solid ${color}">${label}</div>
            <div class="odds-coeff">${coefficient}x</div>
            <div class="odds-payout">${payoutText}</div>
            <div class="odds-prob">${impliedProb}% implied</div>
        `;
        grid.appendChild(card);
    }
}

// ── OPTIONS GRID ──
function updateOptionsGrid() {
    const grid = document.getElementById("optionsGrid");
    grid.innerHTML = "";
    const isOpen = roundData.state === 0;
    const now = Math.floor(Date.now() / 1000);
    const canVote = isOpen && now < roundData.endTime && !!contract; // need signer

    for (let i = 0; i < roundData.numOptions; i++) {
        const color = OPTION_COLORS[i % OPTION_COLORS.length];
        const label = OPTION_LABELS[i % OPTION_LABELS.length];
        const count = voterCounts[i];
        const optionNum = i + 1;

        const btn = document.createElement("button");
        btn.className = "option-btn";

        if (!contract) {
            btn.disabled = true;
            btn.title = "Connect wallet to vote";
        } else if (!canVote) {
            btn.disabled = true;
        } else if (isProcessing) {
            btn.disabled = true;
        }

        btn.style.setProperty("--opt-color", color);

        btn.innerHTML = `
            <span class="option-number" style="color:${color}">${optionNum}</span>
            <span class="option-label">${label}</span>
            <span class="option-voters">${count} voter${count !== 1 ? "s" : ""}</span>
        `;

        btn.addEventListener("click", () => enterLottery(optionNum));
        grid.appendChild(btn);
    }

    // Show connect hint if wallet not connected
    if (!contract && roundData.state === 0) {
        const hint = document.createElement("div");
        hint.className = "connect-hint";
        hint.textContent = "Connect your wallet to vote";
        hint.style.cssText = "grid-column:1/-1;text-align:center;color:var(--text-muted);padding:1rem;";
        grid.appendChild(hint);
    }
}

// ── ENTER LOTTERY ──
async function enterLottery(option) {
    if (!contract) {
        log("Connect your wallet first!", "error");
        return;
    }
    if (isProcessing) {
        log("Transaction already in progress...", "warn");
        return;
    }

    isProcessing = true;
    const statusEl = document.getElementById("entryStatus");
    statusEl.classList.remove("hidden", "success", "error", "pending");
    statusEl.classList.add("pending");
    statusEl.textContent = `Sending transaction for Option ${option}...`;

    // Disable all buttons during transaction
    document.querySelectorAll(".option-btn").forEach(b => b.disabled = true);

    try {
        const tx = await contract.enterLottery(option, { value: roundData.entryFee });
        log(`TX sent: ${tx.hash.slice(0, 14)}...`, "warn");
        statusEl.innerHTML = `Waiting for confirmation... <a href="https://sepolia.etherscan.io/tx/${tx.hash}" target="_blank" rel="noopener">View TX</a>`;

        const receipt = await tx.wait();
        if (receipt.status === 1) {
            userVotedOption = option;
            statusEl.classList.remove("pending");
            statusEl.classList.add("success");
            statusEl.textContent = `Successfully voted for ${OPTION_LABELS[(option - 1) % OPTION_LABELS.length]}!`;
            log(`Entered Option ${option}! TX confirmed.`, "success");
            await refreshAll();
        } else {
            throw new Error("Transaction reverted");
        }
    } catch (err) {
        statusEl.classList.remove("pending");
        statusEl.classList.add("error");
        let msg = err.reason || err.message || "Unknown error";
        if (msg.includes("Wrong fee")) msg = "Incorrect entry fee";
        if (msg.includes("Not open")) msg = "Lottery is not currently open";
        if (msg.includes("Time's up")) msg = "Entry window has closed";
        if (msg.includes("user rejected")) msg = "Transaction rejected by user";
        if (msg.includes("insufficient funds")) msg = "Insufficient ETH balance";
        statusEl.textContent = msg;
        log(`Entry failed: ${msg}`, "error");
    } finally {
        isProcessing = false;
    }
}

// ── TIMER ──
function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    function tick() {
        const now = Math.floor(Date.now() / 1000);
        const remaining = Math.max(0, endTimeCache - now);
        const el = document.getElementById("timerDisplay");

        if (remaining <= 0) {
            if (roundData.state === 0) {
                el.textContent = "EXPIRED — awaiting draw";
                el.style.color = "var(--danger)";
            } else if (roundData.state === 1) {
                el.textContent = "Drawing...";
                el.style.color = "var(--warning)";
            } else {
                el.textContent = "Finished";
                el.style.color = "var(--text-muted)";
            }
            return;
        }
        const h = Math.floor(remaining / 3600);
        const m = Math.floor((remaining % 3600) / 60);
        const s = remaining % 60;
        if (h > 0) {
            el.textContent = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        } else {
            el.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }
        el.style.color = remaining < 60 ? "var(--danger)" : "var(--warning)";
    }
    tick();
    timerInterval = setInterval(tick, 1000);
}

// ── WINNER SECTION ──
async function updateWinnerSection() {
    const section = document.getElementById("winnerSection");
    const claimSection = document.getElementById("claimSection");
    const activeContract = contract || readContract;

    if (!roundData.isDrawn) {
        section.style.display = "none";
        return;
    }

    section.style.display = "block";
    const winLabel = OPTION_LABELS[(roundData.winningOption - 1) % OPTION_LABELS.length];
    document.getElementById("winOptionDisplay").textContent =
        `${winLabel} (#${roundData.winningOption})`;
    const prizeEth = ethers.formatEther(roundData.pot);
    document.getElementById("winPrizeDisplay").textContent = parseFloat(prizeEth).toFixed(4);

    try {
        const winners = await activeContract.getWinners(currentRoundId);
        const listEl = document.getElementById("winnersList");
        listEl.innerHTML = "";
        if (winners.length === 0) {
            listEl.innerHTML = '<div class="winner-addr">No voters for the winning option</div>';
        } else {
            winners.forEach((addr, i) => {
                const div = document.createElement("div");
                div.className = "winner-addr";
                const isYou = userAddress && addr.toLowerCase() === userAddress.toLowerCase();
                div.textContent = `#${i + 1}: ${addr.slice(0, 8)}...${addr.slice(-6)}${isYou ? " (YOU!)" : ""}`;
                if (isYou) div.style.color = "var(--success)";
                listEl.appendChild(div);
            });
        }
    } catch { /* ignore */ }

    // Claim section — only if wallet connected
    if (userAddress && contract) {
        try {
            const claimable = await contract.claimableBalances(userAddress);
            if (claimable > 0n) {
                claimSection.classList.remove("hidden");
                const claimEth = ethers.formatEther(claimable);
                document.getElementById("claimableAmount").textContent =
                    `Claimable: ${parseFloat(claimEth).toFixed(4)} ETH`;
                showWinOverlay(claimEth);
            } else {
                claimSection.classList.add("hidden");
                if (!resultShown && roundData.isDrawn && userVotedOption > 0) {
                    showLoseOverlay();
                }
            }
        } catch {
            claimSection.classList.add("hidden");
        }
    }
}

// ── WIN / LOSE OVERLAYS ──
function showWinOverlay(ethAmount) {
    if (resultShown) return;
    resultShown = true;
    document.getElementById("winAmount").textContent =
        `${parseFloat(ethAmount).toFixed(4)} ETH`;
    document.getElementById("winOverlay").classList.remove("hidden");
}

function closeWinOverlay() {
    document.getElementById("winOverlay").classList.add("hidden");
}

function showLoseOverlay() {
    if (resultShown) return;
    resultShown = true;
    const winLabel = OPTION_LABELS[(roundData.winningOption - 1) % OPTION_LABELS.length];
    document.getElementById("loseSub").textContent =
        `The winning option was ${winLabel} (#${roundData.winningOption}). Better luck next time!`;
    document.getElementById("loseOverlay").classList.remove("hidden");
}

function closeLoseOverlay() {
    document.getElementById("loseOverlay").classList.add("hidden");
}

// ── CLAIM REWARD ──
async function claimReward() {
    if (!contract) {
        log("Connect wallet to claim!", "error");
        return;
    }
    if (isProcessing) return;
    isProcessing = true;

    const btn = document.getElementById("claimBtn");
    const winBtn = document.getElementById("winClaimBtn");
    if (btn) btn.disabled = true;
    if (winBtn) winBtn.disabled = true;

    try {
        const tx = await contract.claimReward();
        log(`Claim TX sent: ${tx.hash.slice(0, 14)}...`, "warn");
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            log("Reward claimed successfully!", "success");
            if (btn) btn.textContent = "Claimed! ✓";
            if (winBtn) winBtn.textContent = "Claimed! ✓";
            await refreshAll();
        } else {
            throw new Error("Claim reverted");
        }
    } catch (err) {
        let msg = err.reason || err.message || "Unknown error";
        if (msg.includes("No rewards")) msg = "No rewards to claim";
        if (msg.includes("user rejected")) msg = "Transaction rejected";
        log(`Claim failed: ${msg}`, "error");
        if (btn) { btn.disabled = false; btn.textContent = "Claim Reward"; }
        if (winBtn) { winBtn.disabled = false; winBtn.textContent = "Claim Reward"; }
    } finally {
        isProcessing = false;
    }
}

// ── LOG ──
function log(message, type = "info") {
    const container = document.getElementById("activityLog");
    if (!container) return;
    const entry = document.createElement("div");
    entry.className = `log-entry log-${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    container.prepend(entry);
    while (container.children.length > 50) container.removeChild(container.lastChild);
}