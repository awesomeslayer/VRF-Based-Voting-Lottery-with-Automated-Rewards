#!/usr/bin/env bash
# run.sh — Deploy, start bot, and serve frontend in one command

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   VRF-Based Voting Lottery — Full Launch Script  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ── 0. Check .env ──
if [ ! -f .env ]; then
    echo -e "${RED} .env file not found. Create it first with RPC_URL and PRIVATE_KEY.${NC}"
    exit 1
fi

source .env

if [ -z "$RPC_URL" ] || [ -z "$PRIVATE_KEY" ]; then
    echo -e "${RED} RPC_URL and PRIVATE_KEY must be set in .env${NC}"
    exit 1
fi

# ── 1. Install Node dependencies if needed ──
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW} Installing Node.js dependencies...${NC}"
    npm install --legacy-peer-deps
fi

# ── 2. Compile contracts ──
echo -e "${YELLOW}🔨 Compiling smart contracts...${NC}"
npx hardhat clean
npx hardhat compile
echo -e "${GREEN} Contracts compiled.${NC}"
echo ""

# ── 3. Deploy ──
echo -e "${YELLOW} Deploying to Sepolia...${NC}"
npx hardhat run scripts/deploy.ts --network hardhat #sepolia
echo -e "${GREEN} Deployment complete.${NC}"
echo ""

# Reload .env to get the new CONTRACT_ADDRESS
source .env
CONTRACT_ADDR=$(echo "$CONTRACT_ADDRESS" | tr -d '"')
echo -e "${CYAN}📝 Contract Address: ${CONTRACT_ADDR}${NC}"
echo ""

echo -e "${RED}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${RED}║  ⚠️  ACTION REQUIRED: Add this contract as a VRF consumer!  ║${NC}"
echo -e "${RED}║  Go to: https://vrf.chain.link/                             ║${NC}"
echo -e "${RED}║  Open your subscription → Add Consumer → Paste address      ║${NC}"
echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Press ENTER after you have added the consumer...${NC}"
read -r

# ── 4. Setup Python venv if needed ──
if [ ! -d "automation/venv" ]; then
    echo -e "${YELLOW}🐍 Setting up Python virtual environment...${NC}"
    cd automation
    python3 -m venv venv
    source venv/bin/activate
    pip install web3==6.11.1 python-dotenv==1.0.0 setuptools==69.5.1
    cd ..
else
    source automation/venv/bin/activate
fi

# ── 5. Start frontend server in background ──
echo -e "${YELLOW}🌐 Starting frontend server on http://localhost:8080 ...${NC}"
cd frontend

# Kill any existing server on port 8080
lsof -ti:8080 | xargs kill -9 2>/dev/null || true

python3 -m http.server 8080 &
FRONTEND_PID=$!
cd ..
echo -e "${GREEN}✅ Frontend running at http://localhost:8080 (PID: $FRONTEND_PID)${NC}"
echo ""

# ── 6. Start the bot ──
echo -e "${CYAN}🤖 Starting automation bot...${NC}"
echo -e "${CYAN}   Users can now enter the lottery via the web UI!${NC}"
echo -e "${CYAN}   The bot will trigger the draw when time expires.${NC}"
echo ""

cd automation
source venv/bin/activate
python bot.py
BOT_EXIT=$?
cd ..

# ── 7. Cleanup ──
echo -e "${YELLOW}🧹 Shutting down frontend server...${NC}"
kill $FRONTEND_PID 2>/dev/null || true

if [ $BOT_EXIT -eq 0 ]; then
    echo -e "${GREEN}✅ Lottery round complete!${NC}"
else
    echo -e "${RED}❌ Bot exited with errors.${NC}"
fi