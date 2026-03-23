# automation/bot.py
import os
import sys
import time
import json
from web3 import Web3
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

RPC_URL = os.getenv("RPC_URL")
PRIVATE_KEY = os.getenv("PRIVATE_KEY")
CONTRACT_ADDRESS = os.getenv("CONTRACT_ADDRESS", "").strip().strip('"')

if not CONTRACT_ADDRESS:
    print("❌ CONTRACT_ADDRESS not set in .env. Deploy first.")
    sys.exit(1)

w3 = Web3(Web3.HTTPProvider(RPC_URL))
if not w3.is_connected():
    print("❌ Failed to connect to the network!")
    sys.exit(1)

print(f"✅ Connected to Sepolia. Chain ID: {w3.eth.chain_id}")

# Try multiple ABI paths
ABI_PATHS = [
    os.path.join(os.path.dirname(__file__), "..", "artifacts", "contracts",
                 "FlexibleVotingLottery.sol", "FlexibleVotingLottery.json"),
    os.path.join(os.path.dirname(__file__), "..", "frontend", "abi.json"),
]

abi = None
for abi_path in ABI_PATHS:
    if os.path.exists(abi_path):
        with open(abi_path, "r") as f:
            data = json.load(f)
            abi = data.get("abi", data) if isinstance(data, dict) else data
        break

if abi is None:
    print("❌ Could not find contract ABI. Compile the contract first.")
    sys.exit(1)

contract = w3.eth.contract(address=Web3.to_checksum_address(CONTRACT_ADDRESS), abi=abi)
account = w3.eth.account.from_key(PRIVATE_KEY)
print(f"🤖 Bot account: {account.address}")


def get_state_name(state):
    return {0: "OPEN", 1: "CALCULATING", 2: "CLOSED"}.get(state, "UNKNOWN")


def check_and_trigger():
    state = contract.functions.lotteryState().call()
    end_time = contract.functions.lotteryEndTime().call()
    current_time = int(time.time())
    remaining = max(0, end_time - current_time)

    print(f"[STATUS] State: {get_state_name(state)} | "
          f"Remaining: {remaining}s | "
          f"End: {end_time} | Now: {current_time}")

    if state == 0 and current_time >= end_time:
        print("\n🎲 [ACTION] Time is up! Triggering the draw...")
        try:
            nonce = w3.eth.get_transaction_count(account.address)
            tx = contract.functions.triggerDraw().build_transaction({
                'from': account.address,
                'nonce': nonce,
                'gas': 300000,
                'gasPrice': w3.eth.gas_price,
            })
            signed_tx = w3.eth.account.sign_transaction(tx, PRIVATE_KEY)
            tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
            print(f"✅ triggerDraw() TX: {tx_hash.hex()}")

            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            if receipt.status == 1:
                print("✅ Transaction confirmed. Waiting for Chainlink VRF callback...\n")
                return True
            else:
                print("❌ Transaction reverted.")
                return False
        except Exception as e:
            print(f"❌ Failed to trigger draw: {e}")
            return False

    if state == 2:
        print("🏁 Lottery is already CLOSED.")
        return "closed"

    if state == 1:
        print("⏳ Already CALCULATING, waiting for VRF...")
        return True

    return False


def listen_for_winner():
    print("👂 [LISTENING] Waiting for WinnersSelected event from Chainlink VRF...")
    start_block = max(0, w3.eth.block_number - 5)
    timeout = 300  # 5 minutes max wait
    start_time = time.time()

    while time.time() - start_time < timeout:
        try:
            current_block = w3.eth.block_number

            events = contract.events.WinnersSelected.get_logs(
                fromBlock=start_block, toBlock=current_block
            )

            for event in events:
                winning_opt = event['args']['winningOption']
                winners = event['args']['winners']
                prize = w3.from_wei(event['args']['totalPrize'], 'ether')

                print("\n" + "=" * 60)
                print("🎉  LOTTERY DRAW COMPLETED!")
                print(f"    Winning Option: {winning_opt}")
                if len(winners) == 0:
                    print("    No one voted for the winning option. Pot stays.")
                else:
                    print(f"    Winners: {len(winners)}")
                    for i, w in enumerate(winners):
                        print(f"      [{i+1}] {w}")
                    print(f"    Total Prize: {prize} ETH")
                    print("    Winners can now call claimReward().")
                print("=" * 60 + "\n")
                return

            # Also check state directly
            state = contract.functions.lotteryState().call()
            if state == 2:
                is_drawn = contract.functions.isDrawn().call()
                if is_drawn:
                    wo = contract.functions.winningOption().call()
                    lp = w3.from_wei(contract.functions.lastPrize().call(), 'ether')
                    winners = contract.functions.getWinners().call()
                    print("\n" + "=" * 60)
                    print("🎉  LOTTERY DRAW COMPLETED (detected via state)!")
                    print(f"    Winning Option: {wo}")
                    print(f"    Winners: {len(winners)}")
                    for i, w_addr in enumerate(winners):
                        print(f"      [{i+1}] {w_addr}")
                    print(f"    Total Prize: {lp} ETH")
                    print("=" * 60 + "\n")
                    return

            start_block = current_block + 1
            elapsed = int(time.time() - start_time)
            print(f"    ⏳ Waiting for VRF callback... ({elapsed}s elapsed)")
            time.sleep(10)

        except Exception as e:
            print(f"    ⚠️ Polling error: {e}")
            time.sleep(10)

    print("⏰ Timeout waiting for VRF callback. Check Chainlink VRF subscription.")


def main():
    is_drawn = contract.functions.isDrawn().call()
    if is_drawn:
        wo = contract.functions.winningOption().call()
        winners = contract.functions.getWinners().call()
        lp = w3.from_wei(contract.functions.lastPrize().call(), 'ether')
        print("🏁 Lottery already completed.")
        print(f"   Winning Option: {wo} | Prize: {lp} ETH | Winners: {len(winners)}")
        return

    state = contract.functions.lotteryState().call()
    end_time = contract.functions.lotteryEndTime().call()
    remaining = max(0, end_time - int(time.time()))
    pot = w3.from_wei(contract.functions.getPot().call(), 'ether')
    entries = contract.functions.totalEntries().call()

    print(f"\n📊 Lottery Status:")
    print(f"   State: {get_state_name(state)}")
    print(f"   Time Remaining: {remaining}s")
    print(f"   Current Pot: {pot} ETH")
    print(f"   Total Entries: {entries}")
    print(f"   Contract: {CONTRACT_ADDRESS}\n")

    if state == 1:
        listen_for_winner()
        return

    print("🤖 Bot monitoring lottery...\n")
    while True:
        result = check_and_trigger()
        if result is True:
            listen_for_winner()
            break
        elif result == "closed":
            break
        time.sleep(15)


if __name__ == "__main__":
    main()