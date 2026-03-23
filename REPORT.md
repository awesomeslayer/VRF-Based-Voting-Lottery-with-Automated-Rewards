# VRF-Based Voting Lottery — Technical Report

## 1. System Overview

This project implements a single-round decentralized lottery on the Ethereum Sepolia testnet. Participants pay a fixed entry fee (0.01 ETH) and vote for one of three options. After a configurable time window, an off-chain Python automation bot triggers the draw. The smart contract requests cryptographically secure randomness from Chainlink VRF v2.5, which determines (a) the winning option and (b) a randomly selected winner among voters of that option. Rewards are distributed via a claimable-balance pattern.

### Architecture

```
User (MetaMask/Web UI)
        │
        │  enterLottery(option) + 0.01 ETH
        ▼
┌─────────────────────┐         ┌──────────────────────┐
│  VotingLottery.sol  │◄───────►│  Chainlink VRF v2.5  │
│  (Sepolia)          │ request │  Coordinator         │
│                     │◄────────│  fulfillRandomWords  │
└─────────────────────┘         └──────────────────────┘
        ▲
        │  triggerDraw()
        │
  Python Automation Bot
  (automation/bot.py)
```

**Components:**

| Component | Technology | Role |
|---|---|---|
| Smart Contract | Solidity 0.8.20, Hardhat | Core lottery logic, prize accounting |
| VRF Oracle | Chainlink VRF v2.5 | Provably fair randomness generation |
| Automation Bot | Python 3, Web3.py | Monitors deadline, triggers draw, logs results |
| Web Interface | HTML, ethers.js | User-facing entry and claim UI |

---

## 2. How VRF Guarantees Fairness

### The Problem with On-Chain Randomness

Generating random numbers on a deterministic blockchain is inherently difficult. Common approaches like using `block.timestamp`, `block.difficulty`, or `blockhash` are vulnerable to miner manipulation — a miner who is also a lottery participant could selectively choose which blocks to publish, biasing the outcome.

### Chainlink VRF Solution

Chainlink VRF (Verifiable Random Function) solves this with a two-step cryptographic protocol:

1. **Request Phase:** The smart contract calls `requestRandomWords()` on the Chainlink VRF Coordinator. This emits an on-chain event containing a `preSeed` derived from the block hash and the request nonce.

2. **Fulfillment Phase:** An off-chain Chainlink oracle node takes the `preSeed`, combines it with its own secret key, and computes a random output along with a cryptographic **proof**. The VRF Coordinator contract verifies this proof on-chain before delivering the random number to our contract via `fulfillRandomWords()`.

### Why This Is Fair

- **Unpredictable:** Neither the contract deployer, participants, nor miners can predict the random number before it is generated because it depends on both the on-chain seed (finalized at request time) and the oracle's secret key.
- **Tamper-Proof:** The oracle cannot manipulate the output because the proof would fail verification. The proof mathematically binds the output to the input seed and the oracle's public key.
- **Verifiable:** Anyone can verify on-chain that the random number was correctly generated from the given inputs.

### How Randomness Maps to Outcomes

In our contract, one random word (`uint256`) determines both outcomes:

```solidity
uint8 winningOption = uint8((randomWord % 3) + 1);     // Option 1, 2, or 3
uint256 winnerIndex = (randomWord / 100) % voters.length; // Index in voter array
```

Using division by 100 ensures the winner index is derived from different bits of the random word than the winning option, providing independent selection.

---

## 3. Payout Computation

### Single-Winner Model

The contract implements a single-winner payout model: the entire prize pool is allocated to one randomly selected winner from the winning option's voter set.

**Payout formula:**

```
prize = contractBalance = entryFee × totalParticipants
```

For example, with 10 participants at 0.01 ETH each, the winner receives 0.1 ETH.

### No-Winner Scenario (Refund)

If the VRF-selected winning option has no voters (e.g., winning option is 1 but all participants voted for 2 and 3), the contract refunds all participants:

```solidity
function _refundAllParticipants() internal {
    for (uint8 opt = 1; opt <= 3; opt++) {
        address[] memory voters = votersByOption[opt];
        for (uint256 i = 0; i < voters.length; i++) {
            claimableBalances[voters[i]] += entryFee;
        }
    }
}
```

Each participant receives exactly their entry fee back via the claimable balance mechanism.

### Pull-over-Push Pattern

Instead of automatically sending ETH (which is vulnerable to reentrancy attacks and can fail if the recipient is a contract that rejects ETH), the system uses a **pull-over-push** pattern:

1. `fulfillRandomWords()` credits `claimableBalances[winner] += prize`
2. The winner calls `claimReward()` to withdraw:
   - Balance is zeroed **before** the transfer (checks-effects-interactions pattern)
   - ETH is sent via low-level `call{value: amount}("")`
   - Reverts on failure

This design prevents reentrancy and ensures funds are never locked due to a failing `transfer()`.

---

## 4. Automation Script

### Purpose

The Python automation bot (`automation/bot.py`) ensures the lottery completes without manual intervention after participants have entered.

### Workflow

```
Start
  │
  ▼
Check isDrawn() ──── true ──► "Already closed" → Exit
  │
  false
  │
  ▼
Poll Loop (every 10s):
  │
  Read lotteryState() and lotteryEndTime()
  │
  ├─ state == OPEN && time < endTime → wait
  │
  └─ state == OPEN && time >= endTime:
       │
       Build & send triggerDraw() transaction
       │
       Wait for confirmation
       │
       ▼
     Listen for WinnerSelected / NoWinnerRefund events
       │
       Poll getLogs every 5s
       │
       ▼
     Print result → Exit
```

### Key Implementation Details

- **Connection:** Uses Web3.py with an Alchemy/Infura RPC endpoint to interact with Sepolia.
- **ABI Loading:** Reads the ABI from Hardhat compilation artifacts (`artifacts/contracts/VotingLottery.sol/VotingLottery.json`), ensuring type safety.
- **Transaction Building:** Manually constructs and signs the `triggerDraw()` transaction with a high gas limit (3,000,000) to accommodate VRF callback complexity.
- **Event Listening:** After triggering the draw, the bot switches to event polling mode, checking for `WinnerSelected` logs from the block where `triggerDraw()` was confirmed.
- **Idempotency:** If the lottery is already drawn (`isDrawn() == true`), the bot exits gracefully without attempting a redundant transaction.

### Automation Guarantees

1. **Liveness:** The bot continuously polls, so as soon as the deadline passes, the draw is triggered within ~10 seconds.
2. **Single Trigger:** The contract's state machine (`OPEN → CALCULATING → CLOSED`) prevents duplicate draws even if multiple bot instances run.
3. **Crash Recovery:** If the bot crashes after sending `triggerDraw()` but before logging the winner, restarting it will detect `isDrawn() == true` and exit (the winner has already been selected on-chain).

---

## 5. Testing

The project includes 22 automated tests using Hardhat and Chainlink's `VRFCoordinatorV2_5Mock`:

| Category | Tests | What's Verified |
|---|---|---|
| Deployment | 2 | Initial state, end time computation |
| Entry | 5 | Valid/invalid fees, options, time window, multi-player |
| Trigger Draw | 4 | Time gating, state transitions, double-trigger prevention |
| Winner Selection | 2 | Full pot allocation, claim flow with balance verification |
| Refund Scenario | 2 | Refund when no voters for winning option, claim of refund |
| Claim Reward | 3 | No-balance revert, event emission, double-claim prevention |
| Edge Cases | 2 | Post-close entry rejection, balance accumulation |

The mock allows deterministic testing by providing specific random words via `fulfillRandomWordsWithOverride()`, enabling precise verification of winner selection logic.

---

## 6. Security Considerations

- **VRF Subscription:** The contract must be registered as a VRF consumer on the Chainlink subscription dashboard. Without this, `requestRandomWords()` reverts.
- **Callback Gas Limit:** Set to 200,000 to ensure `fulfillRandomWords()` has enough gas for winner computation and refund logic.
- **Single-Round Design:** Each contract instance runs one lottery round. This prevents state pollution between rounds and simplifies auditing.
- **No Owner Privileges:** Once deployed, the contract owner has no special powers — they cannot withdraw funds, change the entry fee, or influence the outcome.

---

## 7. Deployment & Demo Instructions

1. Deploy the contract to Sepolia via `npx hardhat run scripts/deploy.ts --network sepolia`
2. Register the contract as a VRF consumer on the Chainlink dashboard
3. Open `frontend/index.html` in a browser, paste the contract address
4. Enter the lottery from multiple MetaMask accounts
5. Run `python automation/bot.py` — it will trigger the draw automatically
6. Watch the web UI update in real time as events arrive
7. The winner claims their reward via the UI
