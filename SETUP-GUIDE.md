# HOW TO SET UP AND BUILD CLAWSTEWARD
# Step-by-step for MacBook Pro M5 32GB
# Written for Imani — no assumed knowledge

## WHAT YOU NEED INSTALLED FIRST

Before anything, make sure these are on your Mac. Open Terminal and run each one:

### 1. Check if Node.js is installed (need v20+)
```bash
node --version
```
If it says "command not found" or shows a version below 20, install it:
```bash
# Using Homebrew (if you have it)
brew install node

# OR download directly from https://nodejs.org (pick the LTS version)
```

### 2. Check if pnpm is installed
```bash
pnpm --version
```
If it says "command not found":
```bash
npm install -g pnpm
```

### 3. Check if Claude Code is installed
```bash
claude --version
```
If it says "command not found":
```bash
npm install -g @anthropic-ai/claude-code
```
Then authenticate:
```bash
claude auth
```
It will open a browser window. Log in with your Anthropic account. Once it says "authenticated" you're good.

### 4. Check if Git is installed
```bash
git --version
```
If not installed, Mac will prompt you to install Xcode Command Line Tools. Say yes.

---

## STEP-BY-STEP: CREATE THE PROJECT

### Step 1: Open Terminal
Press `Cmd + Space`, type "Terminal", hit Enter.

### Step 2: Navigate to where you keep your projects
```bash
cd ~/Projects
```
If that folder doesn't exist:
```bash
mkdir -p ~/Projects
cd ~/Projects
```

### Step 3: Create the project folder
```bash
mkdir clawsteward
cd clawsteward
```

### Step 4: Copy the spec files into this folder
You downloaded files from Claude. They are in your Downloads folder (or wherever your browser saves files). Copy them in and rename to the correct filenames:

```bash
cp ~/Downloads/CLAUDE-clawsteward-master-spec.md ./CLAUDE.md
cp ~/Downloads/PROJECT-BRIEF-clawsteward-strategy.md ./PROJECT_BRIEF.md
cp ~/Downloads/package-clawsteward-dependencies.json ./package.json
cp ~/Downloads/tsconfig-clawsteward-typescript.json ./tsconfig.json
cp ~/Downloads/vitest-config-clawsteward-testing.ts ./vitest.config.ts
cp ~/Downloads/env-example-clawsteward-config.txt ./.env.example
cp ~/Downloads/gitignore-clawsteward.txt ./.gitignore
```

**IMPORTANT:** The CLAUDE.md file MUST be named exactly `CLAUDE.md` in your project root. That's what Claude Code looks for automatically.

### Step 5: Verify everything is in place
```bash
ls -la
```
You should see:
```
CLAUDE.md
PROJECT_BRIEF.md
package.json
tsconfig.json
vitest.config.ts
.env.example
.gitignore
```

### Step 6: Initialize Git
```bash
git init
```

### Step 7: Install dependencies
```bash
pnpm install
```
This reads package.json and installs everything you need. Wait for it to finish.

### Step 8: Create the .env file
```bash
cp .env.example .env
```
Then open .env in your editor and add your Solana RPC URL. The free default works for testing:
```
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```
For better performance, get a free Helius key at https://dev.helius.xyz and use:
```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY_HERE
```

### Step 9: Launch Claude Code
```bash
claude
```

That's it. Claude Code opens in your terminal. It automatically reads CLAUDE.md from your project root and understands the entire ClawSteward spec.

### Step 10: Tell Claude Code to start building
Type this as your first message to Claude Code:

```
Read CLAUDE.md and PROJECT_BRIEF.md. You are building ClawSteward by ClawStack. Follow the exact spec — start with Week 1 Day 1-2: project scaffold, src/core/types.ts, src/db/schema.sql, and src/db/database.ts. Follow the build sequence in CLAUDE.md precisely. Do not skip ahead. Do not deviate from the architecture.
```

Claude Code will start creating files and writing code. You review what it produces.

---

## HOW CLAUDE CODE WORKS (THE BASICS)

- **Claude Code runs in your terminal.** It can read files, write files, run commands, and execute code on your machine.
- **CLAUDE.md is the instruction file.** It's like giving a contractor the blueprints. Claude Code reads it automatically.
- **You are the reviewer.** Claude Code proposes changes, you approve or reject. It will ask permission before running commands.
- **You can talk to it naturally.** "Run the tests", "Show me the policy engine", "Fix the failing test", "Add the Solana adapter" — it understands.
- **If it goes off-spec, pull it back.** Say "Check CLAUDE.md — the spec says X, you did Y. Fix it."

## USEFUL CLAUDE CODE COMMANDS

```
# While inside Claude Code:
/help              # See all commands
/cost              # See how much you've spent this session
/clear             # Clear conversation history
Ctrl+C             # Cancel current operation
/exit              # Exit Claude Code
```

## DAILY WORKFLOW

```bash
cd ~/Projects/clawsteward
claude
```
Then tell it what to build next from the Week 1/2/3 schedule in CLAUDE.md.

After each session:
```bash
git add -A
git commit -m "Day X: description of what was built"
```

When ready to push to GitHub:
```bash
# Create repo on github.com first (github.com/SkunkWorks0x/clawsteward)
git remote add origin https://github.com/SkunkWorks0x/clawsteward.git
git branch -M main
git push -u origin main
```

---

## IF SOMETHING BREAKS

- **pnpm install fails:** Try `npm install` instead
- **Claude Code can't authenticate:** Run `claude auth` again
- **Tests fail:** Tell Claude Code "Run the tests and fix any failures"
- **TypeScript errors:** Tell Claude Code "Run typecheck and fix all errors"
- **Claude Code goes off-spec:** Say "Read CLAUDE.md section [X]. You deviated. Fix it."
- **Stuck on anything:** Come back to the Claude chat and ask me
