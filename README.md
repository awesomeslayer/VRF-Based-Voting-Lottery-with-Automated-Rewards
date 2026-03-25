
# VRF-Based Voting Lottery with Automated Rewards

This project implements a decentralized multi-round lottery system on the Ethereum Sepolia testnet. Participants enter the lottery by paying a configurable entry fee and voting for one of several options. Once the predefined entry window closes, an off-chain Python automation script triggers the smart contract. The contract requests cryptographically secure randomness via Chainlink VRF v2.5 to select a winning option. Depending on the round configuration, either all voters on the winning option split the prize pool or a single random winner is selected. Rewards are allocated securely using a pull-over-push pattern.

---

## Project Architecture & Flow

1. **Round Creation:** The owner calls `startNewRound()` specifying the entry fee, duration, number of options, and prize distribution mode.
2. **User Entry:** Users call `enterLottery(option)` sending the round's entry fee (e.g., 0.001 ETH).
3. **Monitoring:** A Python bot continuously checks the lottery deadline via Web3.py.
4. **Trigger:** Once the deadline passes, the bot executes `triggerDraw()`.
5. **VRF Request:** The smart contract halts entries and requests random words from Chainlink VRF.
6. **Resolution:** Chainlink calls back `fulfillRandomWords`. The contract picks a winning option using the first random word. If `splitAmongAllWinners` is enabled, the entire prize pool is divided equally among all voters on the winning option. Otherwise, the second random word selects a single random winner from that option. Balances are updated and the `WinnersSelected` event is emitted.
7. **Automation Complete:** The bot catches the event and logs the result. Winners can claim their rewards via `claimReward()`.

---

## Prerequisites

- Node.js (v18 or higher)
- Python (v3.10 or higher)
- MetaMask extension (configured for the Sepolia testnet)


## Installation Guide

### Step 1: Clone the Repository
```bash
git clone git@github.com:awesomeslayer/VRF-Based-Voting-Lottery-with-Automated-Rewards.git
cd VRF-Based-Voting-Lottery-with-Automated-Rewards
```

### Step 2: Smart Contract Setup (Node.js)
Initialize the project and install strict versions of dependencies to prevent Hardhat v2/v3 and ESM/CommonJS conflicts.

```bash
npm init -y
# Ensure "type": "module" is NOT in your package.json. If it is, delete it.
npm install --save-dev hardhat@2.22.10 @nomicfoundation/hardhat-toolbox@5.0.0 @nomicfoundation/hardhat-ignition@0.15.5 @nomicfoundation/ignition-core@0.15.5 @chainlink/contracts@1.2.0 @openzeppelin/contracts@5.0.2 dotenv ts-node typescript @types/node@20 @types/mocha@10 @types/chai@4.3.16 ethers@6.13.2 --legacy-peer-deps
```

### Step 3: Automation Bot Setup (Python)
Navigate to the automation folder and set up a virtual environment.

```bash
cd automation
python3 -m venv venv
source venv/bin/activate  # On Windows use: venv\Scripts\activate
pip install web3==6.11.1 python-dotenv==1.0.0 setuptools==69.5.1
cd ..
```

---

## Configuration and Ecosystem Setup

### 1. Environment Variables
Create a `.env` file in the root directory:
```env
RPC_URL=""
PRIVATE_KEY=""
CONTRACT_ADDRESS=""

# Contract
NUM_OPTIONS="4"
SPLIT_AMONG_ALL="true"
ENTRY_FEE="0.001"
DURATION_MINUTES="5"
```

### 2. Acquiring API Keys and Testnet Funds
- **RPC URL:** Go to [Alchemy](https://www.alchemy.com/), create an app for Ethereum Sepolia, and copy the HTTPS RPC URL into `.env`.
  
  ![Alchemy Setup](pictures/alchemy_rpc.png)

- **Private Key:** Export your Sepolia private key from MetaMask and paste it into `.env` (without `0x`).

  ![Private Key](pictures/metamask_small.png)

- **Testnet ETH:** Obtain Sepolia ETH from the [Google Web3 Faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia).
  
  ![ETH Faucet](pictures/faucets_eth.png)

- **Testnet LINK:** Obtain LINK tokens from the [Chainlink Faucet](https://faucets.chain.link/).
  
  ![LINK Faucet](pictures/faucets_link.png)

### 3. Setting Up Chainlink VRF
1. Go to the [Chainlink VRF Dashboard](https://vrf.chain.link/).
2. Click "Create Subscription", fund it with your testnet LINK tokens.
3. Note your `Subscription ID`.
  
  ![Chainlink VRF](pictures/chainlink_subscription.png)

---

## Compilation & Deployment

1. Open `scripts/deploy.ts` and replace the `subId` variable with your actual Subscription ID.
2. Compile the contracts:
   ```bash
   npx hardhat clean
   npx hardhat compile
   ```
3. Deploy to Sepolia:
   ```bash
   npx hardhat run scripts/deploy.ts --network sepolia
   ```

4. The deployed contract address will be automatically added to `CONTRACT_ADDRESS` in `.env`.
5. Verify your contract using:    
    ```bash
    bash verify.sh
    ```
6. **CRITICAL:** Return to the [Chainlink VRF Dashboard](https://vrf.chain.link/), open your subscription, click **"Add consumer"**, and paste your contract address.

---

## Running the Project

1. If the current round is `CLOSED`, as the owner call `startNewRound()` specifying parameters.

2. **Enter the Lottery:** You can enter the lottery by calling `enterLottery()` and sending the round's entry fee (e.g., 0.001 ETH) via a custom script or Etherscan before the time expires.
3. **Start the Automation Bot:**
   ```bash
   cd automation
   source venv/bin/activate
   python bot.py
   ```

### Expected Bot Output

The bot will monitor the blockchain. Once the deadline passes, it will trigger the contract, wait for the VRF callback, and output the final result (winning option and the winner's address or addresses).

![Bot Output](pictures/bot_output.png)

---

## Starting a New Lottery Round

The contract supports **multiple sequential rounds** without redeployment. Once a round is drawn and closed, the owner can call `startNewRound()` with new parameters (entry fee, duration, number of options, distribution mode) to begin the next round. The bot or a script can invoke this automatically, or it can be done manually via Etherscan.

If the previous round expired with zero entries, `startNewRound()` will auto-close it before creating the next round.