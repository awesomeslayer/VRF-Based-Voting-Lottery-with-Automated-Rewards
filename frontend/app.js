// frontend/app.js

// ── CONFIGURATION ──
// Set your contract address here, or it will be read from abi.json fetch context
let CONTRACT_ADDRESS = "";

let provider = null;
let signer = null;
let contract = null;
let contractAbi = null;
let userAddress = null;
let lotteryInfo = null;
let refreshInterval = null;
let timerInterval = null;
let endTimeCache = 0;

const COLORS = ["color-1", "color-2", "color-3", "color-4", "color-5", "color-6"];
const OPTION_EMOJIS = ["🔴", "🔵", "🟢", "🟡", "🟣", "🟠", "⚪", "🟤"];

// ── INIT ──
document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("connectBtn").addEventListener("click", connectWallet);
    document.getElementById("claimBtn")?.addEventListener("click", claimReward);

    // Try to load ABI
    try {
        const resp = await fetch("abi.json");
        contractAbi = await resp.json();
        log("ABI loaded.", "info");
    } catch (e) {
        log("⚠️ Could not load abi.json. Deploy the contract first.", "error");
        return;
    }

    // Check if MetaMask is already connected
    if (typeof window.ethereum !== "undefined") {
        const accounts = await window.ethereum.request({ method: "eth_accounts" });
        if (accounts.length > 0) {
            await connectWallet();
        }
    }
});

// ── CONNECT ──
async function connectWallet() {
    if (typeof window.ethereum === "undefined") {
        log("MetaMask not detected!", "error");
        alert("Please install MetaMask to use this dApp.");
        return;
    }

    try {
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        userAddress = accounts[0];

        const network = await provider.getNetwork();
        const chainId = Number(network.chainId);

        document.getElementById("connectBtn").classList.add("hidden");
        document.getElementById("accountInfo").classList.remove("hidden");
        document.getElementById("accountAddress").textContent =
            userAddress.slice(0, 6) + "..." + userAddress.slice(-4);

        if (chainId !== 11155111) {
            document.getElementById("networkWarning").classList.remove("hidden");
            log("Wrong network! Switch to Sepolia.", "warn");
            return;
        }

        document.getElementById("networkWarning").classList.add("hidden");
        log(`Connected: ${userAddress.slice(0, 10)}...`, "success");

        await initContract();

        // Listen for account/network changes
        window.ethereum.on("accountsChanged", () => window.location.reload());
        window.ethereum.on("chainChanged", () => window.location.reload());

    } catch (err) {
        log(`Connection failed: ${err.message}`, "error");
    }
}

// ── INIT CONTRACT ──
async function initContract() {
    // Read contract address from environment or prompt
    if (!CONTRACT_ADDRESS) {
        // Try to get from a meta tag or prompt
        const stored = localStorage.getItem("CONTRACT_ADDRESS");
        if (stored) {
            CONTRACT_ADDRESS = stored;
        } else {
            CONTRACT_ADDRESS = prompt(
                "Enter the deployed contract address (from .env):",
                "0x..."
            );
            if (CONTRACT_ADDRESS) {
                localStorage.setItem("CONTRACT_ADDRESS", CONTRACT_ADDRESS);
            }
        }
    }

    if (!CONTRACT_ADDRESS || CONTRACT_ADDRESS === "0x...") {
        log("No contract address provided.", "error");
        return;
    }

    try {
        contract = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, signer);

        // Update contract link
        const link = document.getElementById("contractLink");
        link.textContent = CONTRACT_ADDRESS.slice(0, 10) + "..." + CONTRACT_ADDRESS.slice(-8);
        link.href = `https://sepolia.etherscan.io/address/${CONTRACT_ADDRESS}`;

        log(`Contract loaded: ${CONTRACT_ADDRESS.slice(0, 10)}...`, "success");

        await refreshAll();

        // Auto-refresh every 10 seconds
        if (refreshInterval) clearInterval(refreshInterval);
        refreshInterval = setInterval(refreshAll, 10000);

    } catch (err) {
        log(`Failed to init contract: ${err.message}`, "error");
    }
}

// ── REFRESH ALL DATA ──
async function refreshAll() {
    try {
        const info = await contract.getLotteryInfo();
        lotteryInfo = {
            state: Number(info[0]),
            pot: info[1],
            endTime: Number(info[2]),
            entryFee: info[3],
            numOptions: Number(info[4]),
            splitAmongAll: info[5],
            totalEntries: Number(info[6]),
            isDrawn: info[7],
            winningOption: Number(info[8]),
            lastPrize: info[9],
        };

        endTimeCache = lotteryInfo.endTime;

        updateStatusDisplay();
        await updateOptionsGrid();
        await updateEarningsGrid();
        await updateWinnerSection();
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

    // State badge
    const stateNames = ["OPEN", "CALCULATING", "CLOSED"];
    const badgeClasses = ["badge-open", "badge-calculating", "badge-closed"];
    const stateName = stateNames[lotteryInfo.state] || "UNKNOWN";
    stateEl.innerHTML = `<span class="badge ${badgeClasses[lotteryInfo.state]}">${stateName}</span>`;

    // Pot
    const potEth = ethers.formatEther(lotteryInfo.pot);
    potEl.textContent = `${parseFloat(potEth).toFixed(4)} ETH`;

    // Entries
    entriesEl.textContent = lotteryInfo.totalEntries;

    // Fee
    const feeEth = ethers.formatEther(lotteryInfo.entryFee);
    feeEl.textContent = `${feeEth} ETH`;

    // Mode
    modeEl.textContent = lotteryInfo.splitAmongAll ? "Split Among All" : "Single Winner";
}

// ── TIMER ──
function startTimer() {
    if (timerInterval) clearInterval(timerInterval);

    function updateTimer() {
        const now = Math.floor(Date.now() / 1000);
        const remaining = Math.max(0, endTimeCache - now);
        const timerEl = document.getElementById("timerDisplay");

        if (remaining <= 0) {
            if (lotteryInfo.state === 0) {
                timerEl.textContent = "⏰ EXPIRED";
                timerEl.style.color = "var(--danger)";
            } else if (lotteryInfo.state === 1) {
                timerEl.textContent = "⏳ Drawing...";
                timerEl.style.color = "var(--warning)";
            } else {
                timerEl.textContent = "🏁 Finished";
                timerEl.style.color = "var(--text-muted)";
            }
            return;
        }

        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        timerEl.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
        timerEl.style.color = remaining < 60 ? "var(--danger)" : "var(--warning)";
    }

    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
}

// ── OPTIONS GRID ──
async function updateOptionsGrid() {
    const grid = document.getElementById("optionsGrid");
    grid.innerHTML = "";

    const numOpts = lotteryInfo.numOptions;
    const isOpen = lotteryInfo.state === 0;
    const now = Math.floor(Date.now() / 1000);
    const canVote = isOpen && now < lotteryInfo.endTime;

    for (let i = 1; i <= numOpts; i++) {
        let voterCount = 0;
        try {
            voterCount = Number(await contract.getVoterCount(i));
        } catch (e) { /* ignore */ }

        const btn = document.createElement("button");
        btn.className = `option-btn ${COLORS[(i - 1) % COLORS.length]}`;
        btn.disabled = !canVote;

        const emoji = OPTION_EMOJIS[(i - 1) % OPTION_EMOJIS.length];

        btn.innerHTML = `
            <span class="option-number">${emoji} ${i}</span>
            <span class="option-label">Option ${i}</span>
            <span class="option-voters">${voterCount} voter${voterCount !== 1 ? "s" : ""}</span>
        `;

        btn.addEventListener("click", () => enterLottery(i));
        grid.appendChild(btn);
    }
}

// ── EARNINGS GRID ──
async function updateEarningsGrid() {
    const grid = document.getElementById("earningsGrid");
    grid.innerHTML = "";

    const numOpts = lotteryInfo.numOptions;
    const potWei = lotteryInfo.pot;
    // Hypothetical pot includes the user's potential entry
    const entryFeeWei = lotteryInfo.entryFee;
    // If user hasn't entered yet, the pot after their entry would be pot + entryFee
    // We'll show current pot for simplicity

    for (let i = 1; i <= numOpts; i++) {
        let voterCount = 0;
        try {
            voterCount = Number(await contract.getVoterCount(i));
        } catch (e) { /* ignore */ }

        const card = document.createElement("div");
        card.className = "earning-card";

        let earningText = "0 ETH";
        let detailText = "No voters yet";

        if (lotteryInfo.splitAmongAll) {
            if (voterCount > 0) {
                const share = potWei / BigInt(voterCount);
                earningText = `${parseFloat(ethers.formatEther(share)).toFixed(4)} ETH`;
                detailText = `Pot ÷ ${voterCount} voters`;
            } else {
                // If they'd be the first voter, they'd get the whole pot
                earningText = `${parseFloat(ethers.formatEther(potWei + entryFeeWei)).toFixed(4)} ETH`;
                detailText = "You'd be first! Full pot";
            }
        } else {
            // Single winner mode
            earningText = `${parseFloat(ethers.formatEther(potWei)).toFixed(4)} ETH`;
            if (voterCount > 0) {
                const chance = (100 / voterCount).toFixed(1);
                detailText = `1/${voterCount} chance (${chance}%)`;
            } else {
                detailText = "Guaranteed if option wins";
            }
        }

        card.innerHTML = `
            <div class="earning-option">${OPTION_EMOJIS[(i - 1) % OPTION_EMOJIS.length]} Option ${i}</div>
            <div class="earning-amount">${earningText}</div>
            <div class="earning-detail">${detailText}</div>
        `;

        grid.appendChild(card);
    }
}

// ── ENTER LOTTERY ──
async function enterLottery(option) {
    const statusEl = document.getElementById("entryStatus");
    statusEl.classList.remove("hidden", "success", "error", "pending");
    statusEl.classList.add("pending");
    statusEl.textContent = `⏳ Sending transaction for Option ${option}...`;

    try {
        const tx = await contract.enterLottery(option, {
            value: lotteryInfo.entryFee,
        });

        log(`TX sent: ${tx.hash.slice(0, 14)}...`, "warn");
        statusEl.textContent = `⏳ Waiting for confirmation... TX: ${tx.hash.slice(0, 14)}...`;

        const receipt = await tx.wait();

        if (receipt.status === 1) {
            statusEl.classList.remove("pending");
            statusEl.classList.add("success");
            statusEl.textContent = `✅ Successfully voted for Option ${option}!`;
            log(`Entered Option ${option}! TX confirmed.`, "success");
            await refreshAll();
        } else {
            throw new Error("Transaction reverted");
        }

    } catch (err) {
        statusEl.classList.remove("pending");
        statusEl.classList.add("error");

        let msg = err.reason || err.message || "Unknown error";
        if (msg.includes("Incorrect entry fee")) msg = "Incorrect entry fee (must be exactly 0.01 ETH)";
        if (msg.includes("not open")) msg = "Lottery is not currently open";
        if (msg.includes("Entry window is closed")) msg = "Entry window has closed";
        if (msg.includes("user rejected")) msg = "Transaction rejected by user";

        statusEl.textContent = `❌ ${msg}`;
        log(`Entry failed: ${msg}`, "error");
    }
}

// ── WINNER SECTION ──
async function updateWinnerSection() {
    const section = document.getElementById("winnerSection");
    const claimSection = document.getElementById("claimSection");

    if (!lotteryInfo.isDrawn) {
        section.style.display = "none";
        return;
    }

    section.style.display = "block";

    document.getElementById("winOptionDisplay").textContent =
        `${OPTION_EMOJIS[(lotteryInfo.winningOption - 1) % OPTION_EMOJIS.length]} Option ${lotteryInfo.winningOption}`;

    const prizeEth = ethers.formatEther(lotteryInfo.lastPrize);
    document.getElementById("winPrizeDisplay").textContent = parseFloat(prizeEth).toFixed(4);

    // Get winners list
    try {
        const winners = await contract.getWinners();
        const listEl = document.getElementById("winnersList");
        listEl.innerHTML = "";

        if (winners.length === 0) {
            listEl.innerHTML = '<div class="winner-addr">No voters for the winning option</div>';
        } else {
            winners.forEach((addr, i) => {
                const div = document.createElement("div");
                div.className = "winner-addr";
                div.textContent = `#${i + 1}: ${addr.slice(0, 8)}...${addr.slice(-6)}`;
                listEl.appendChild(div);
            });
        }
    } catch (e) { /* ignore */ }

    // Check if current user can claim
    if (userAddress) {
        try {
            const claimable = await contract.claimableBalances(userAddress);
            if (claimable > 0n) {
                claimSection.classList.remove("hidden");
                const claimEth = ethers.formatEther(claimable);
                document.getElementById("claimableAmount").textContent =
                    `Claimable: ${parseFloat(claimEth).toFixed(4)} ETH`;
            } else {
                claimSection.classList.add("hidden");
            }
        } catch (e) {
            claimSection.classList.add("hidden");
        }
    }
}

// ── CLAIM REWARD ──
async function claimReward() {
    const btn = document.getElementById("claimBtn");
    btn.disabled = true;
    btn.textContent = "⏳ Claiming...";

    try {
        const tx = await contract.claimReward();
        log(`Claim TX sent: ${tx.hash.slice(0, 14)}...`, "warn");

        const receipt = await tx.wait();
        if (receipt.status === 1) {
            log("🎉 Reward claimed successfully!", "success");
            btn.textContent = "✅ Claimed!";
            await refreshAll();
        } else {
            throw new Error("Claim transaction reverted");
        }
    } catch (err) {
        let msg = err.reason || err.message || "Unknown error";
        if (msg.includes("No rewards")) msg = "No rewards to claim";
        if (msg.includes("user rejected")) msg = "Transaction rejected by user";

        log(`Claim failed: ${msg}`, "error");
        btn.disabled = false;
        btn.textContent = "💸 Claim Reward";
    }
}

// ── LOGGING ──
function log(message, type = "info") {
    const logContainer = document.getElementById("activityLog");
    const entry = document.createElement("div");
    entry.className = `log-entry log-${type}`;

    const time = new Date().toLocaleTimeString();
    entry.textContent = `[${time}] ${message}`;

    logContainer.prepend(entry);

    // Keep only last 50 entries
    while (logContainer.children.length > 50) {
        logContainer.removeChild(logContainer.lastChild);
    }
}