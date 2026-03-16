import os
import time
import json
from web3 import Web3
from dotenv import load_dotenv

load_dotenv(dotenv_path="../.env")

RPC_URL = os.getenv("RPC_URL")
PRIVATE_KEY = os.getenv("PRIVATE_KEY")
CONTRACT_ADDRESS = os.getenv("CONTRACT_ADDRESS")

if not CONTRACT_ADDRESS:
    raise ValueError("PLEASE DEPLOY CONTRACT FIRST AND ADD CONTRACT_ADDRESS TO .env!")

w3 = Web3(Web3.HTTPProvider(RPC_URL))
if not w3.is_connected():
    raise Exception("Failed to connect to the network!")

print(f"Connected to Sepolia network. Chain ID: {w3.eth.chain_id}")

ABI_PATH = "../artifacts/contracts/VotingLottery.sol/VotingLottery.json"
with open(ABI_PATH, "r") as file:
    contract_json = json.load(file)
    abi = contract_json["abi"]

contract = w3.eth.contract(address=CONTRACT_ADDRESS, abi=abi)
account = w3.eth.account.from_key(PRIVATE_KEY)

def check_and_trigger():
    state = contract.functions.lotteryState().call()
    end_time = contract.functions.lotteryEndTime().call()
    current_time = int(time.time())

    print(f"[STATUS] State: {state} | End Time: {end_time} | Current Time: {current_time}")

    if state == 0 and current_time >= end_time:
        print("\n[ACTION] Time is up! Triggering the draw...")
        try:
            tx = contract.functions.triggerDraw().build_transaction({
                'from': account.address,
                'nonce': w3.eth.get_transaction_count(account.address),
                'gas': 3000000,
                'gasPrice': w3.eth.gas_price
            })
            signed_tx = w3.eth.account.sign_transaction(tx, PRIVATE_KEY)
            tx_hash = w3.eth.send_raw_transaction(signed_tx.rawTransaction)
            print(f"[SUCCESS] triggerDraw() sent! TX Hash: {tx_hash.hex()}")
            
            w3.eth.wait_for_transaction_receipt(tx_hash)
            print("[SUCCESS] Transaction confirmed. Waiting for Chainlink VRF...\n")
            return True
        except Exception as e:
            print(f"[ERROR] Failed to trigger draw: {e}")
            return False
    return False

def listen_for_winner():
    print("[LISTENING] Waiting for WinnerSelected event from Chainlink VRF...")
    latest_block = w3.eth.block_number
    
    while True:
        try:
            events = contract.events.WinnerSelected.get_logs(fromBlock=latest_block)
            for event in events:
                winning_option = event['args']['winningOption']
                winner = event['args']['winner']
                prize = w3.from_wei(event['args']['prize'], 'ether')
                
                print("\n================================================")
                print("LOTTERY DRAW COMPLETED!")
                print(f"Winning Option: {winning_option}")
                if winner == "0x0000000000000000000000000000000000000000":
                    print("No one voted for the winning option. Pot rolls over.")
                else:
                    print(f"Winner Address: {winner}")
                    print(f"Prize Allocated: {prize} ETH")
                    print("Automation complete. Winner can now claimReward().")
                print("================================================\n")
                return
                
            latest_block = w3.eth.block_number
            time.sleep(5)
        except Exception as e:
            print(f"Searching events... (Keep waiting)")
            time.sleep(5)

if __name__ == "__main__":
    is_drawn = contract.functions.isDrawn().call()
    if is_drawn:
        print("Lottery has already been drawn and closed.")
    else:
        print("Bot started monitoring the lottery...")
        while True:
            triggered = check_and_trigger()
            if triggered:
                listen_for_winner()
                break
            time.sleep(10)