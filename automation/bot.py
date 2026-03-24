import os
import time
from web3 import Web3
from dotenv import load_dotenv

load_dotenv()

w3 = Web3(Web3.HTTPProvider(os.getenv("RPC_URL")))
account = w3.eth.account.from_key(os.getenv("PRIVATE_KEY"))

# Упрощенное ABI (только нужные функции)
ABI = '[{"inputs":[],"name":"currentRoundId","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"rounds","outputs":[{"internalType":"uint256","name":"roundId","type":"uint256"},{"internalType":"uint256","name":"entryFee","type":"uint256"},{"internalType":"uint256","name":"endTime","type":"uint256"},{"internalType":"uint8","name":"numOptions","type":"uint8"},{"internalType":"bool","name":"splitAmongAllWinners","type":"bool"},{"internalType":"uint8","name":"state","type":"uint8"},{"internalType":"bool","name":"isDrawn","type":"bool"},{"internalType":"uint8","name":"winningOption","type":"uint8"},{"internalType":"uint256","name":"totalPot","type":"uint256"},{"internalType":"uint256","name":"totalEntries","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"triggerDraw","outputs":[],"stateMutability":"nonpayable","type":"function"}]'

contract = w3.eth.contract(address=os.getenv("CONTRACT_ADDRESS"), abi=ABI)

def monitor():
    print(f"🤖 Bot started monitoring: {os.getenv('CONTRACT_ADDRESS')}")
    while True:
        try:
            round_id = contract.functions.currentRoundId().call()
            round_data = contract.functions.rounds(round_id).call()
            
            # Структура: [roundId, fee, endTime, numOpt, split, state, isDrawn...]
            # state: 0=OPEN, 1=CALCULATING, 2=CLOSED
            state = round_data[5]
            end_time = round_data[2]
            
            if state == 0 and time.time() > end_time:
                print(f"⏰ Round {round_id} ended! Triggering draw...")
                tx = contract.functions.triggerDraw().build_transaction({
                    'from': account.address,
                    'nonce': w3.eth.get_transaction_count(account.address),
                    'gas': 300000,
                    'gasPrice': w3.eth.gas_price
                })
                signed_tx = w3.eth.account.sign_transaction(tx, private_key=account.key)
                tx_hash = w3.eth.send_raw_transaction(signed_tx.rawTransaction)
                print(f"✅ Triggered! Hash: {tx_hash.hex()}")
            
            elif state == 1:
                print(f"⏳ VRF is calculating for Round {round_id}...")
            
            elif state == 2:
                print(f"🏁 Round {round_id} is CLOSED. Waiting for owner to start new round.")

        except Exception as e:
            print(f"❌ Error: {e}")
        
        time.sleep(30)

if __name__ == "__main__":
    monitor()