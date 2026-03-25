import os
import time
from pathlib import Path
from web3 import Web3
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")

w3 = Web3(Web3.HTTPProvider(os.getenv("RPC_URL")))
account = w3.eth.account.from_key(os.getenv("PRIVATE_KEY"))

# Упрощенное ABI (только нужные функции)
ABI = '[{"inputs":[],"name":"currentRoundId","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"rounds","outputs":[{"internalType":"uint256","name":"roundId","type":"uint256"},{"internalType":"uint256","name":"entryFee","type":"uint256"},{"internalType":"uint256","name":"endTime","type":"uint256"},{"internalType":"uint8","name":"numOptions","type":"uint8"},{"internalType":"bool","name":"splitAmongAllWinners","type":"bool"},{"internalType":"uint8","name":"state","type":"uint8"},{"internalType":"bool","name":"isDrawn","type":"bool"},{"internalType":"uint8","name":"winningOption","type":"uint8"},{"internalType":"uint256","name":"totalPot","type":"uint256"},{"internalType":"uint256","name":"totalEntries","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"triggerDraw","outputs":[],"stateMutability":"nonpayable","type":"function"}]'

contract = w3.eth.contract(address=os.getenv("CONTRACT_ADDRESS"), abi=ABI)

def monitor():
    print(f"Bot started monitoring: {os.getenv('CONTRACT_ADDRESS')}")
    while True:
        try:
            round_id = contract.functions.currentRoundId().call()
            round_data = contract.functions.rounds(round_id).call()
            
            # state: 0=OPEN, 1=CALCULATING, 2=CLOSED
            state = round_data[5]
            end_time = round_data[2]
            
            if state == 0 and time.time() > end_time:
                entries = round_data[9]
                if entries == 0:
                    print(f"Round {round_id} ended but has 0 participants. Cannot draw.")
                else:
                    print(f"Round {round_id} ended ({entries} participants)! Triggering draw...")
                    tx = contract.functions.triggerDraw().build_transaction({
                        'from': account.address,
                        'nonce': w3.eth.get_transaction_count(account.address),
                        'gas': 300000,
                    })
                    signed_tx = w3.eth.account.sign_transaction(tx, private_key=account.key)
                    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
                    print(f"Triggered! TX: {tx_hash.hex()}")
            
            if state == 0 and time.time() <= end_time:
                remaining = int(end_time - time.time())
                print(f"Round {round_id} OPEN — {remaining}s remaining, {round_data[9]} entries")

            elif state == 1:
                print(f"Round {round_id} — VRF is calculating...")
            
            elif state == 2:
                print(f"Round {round_id} CLOSED. Winning option: {round_data[7]}")

        except Exception as e:
            print(f"Error: {e}")
        
        time.sleep(15)

if __name__ == "__main__":
    monitor()