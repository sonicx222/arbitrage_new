#!/bin/bash
# =============================================================================
# Git History Cleanup Script
# =============================================================================
# This script removes sensitive files (.env, .env.local, logs) from git history.
#
# PREREQUISITES:
# 1. Install git-filter-repo: pip install git-filter-repo
# 2. Backup your repository: cp -r arbitrage_new arbitrage_new.backup
# 3. Ensure all team members know about the history rewrite
#
# USAGE:
#   chmod +x scripts/cleanup-git-history.sh
#   ./scripts/cleanup-git-history.sh
#
# AFTER RUNNING:
#   1. Force push to remote: git push --force --all
#   2. All team members must re-clone or: git fetch --all && git reset --hard origin/main
#   3. IMMEDIATELY ROTATE ALL COMPROMISED API KEYS (see list below)
# =============================================================================

set -e

echo "=============================================="
echo "Git History Cleanup Script"
echo "=============================================="

# Check if git-filter-repo is installed
if ! command -v git-filter-repo &> /dev/null; then
    echo "ERROR: git-filter-repo is not installed."
    echo "Install it with: pip install git-filter-repo"
    echo ""
    echo "Alternatively, use BFG Repo-Cleaner:"
    echo "1. Download from: https://rtyley.github.io/bfg-repo-cleaner/"
    echo "2. Run: java -jar bfg.jar --delete-files '.env' --delete-files '.env.local'"
    exit 1
fi

echo ""
echo "WARNING: This will permanently rewrite git history!"
echo "Make sure you have:"
echo "  1. Backed up the repository"
echo "  2. Notified all team members"
echo "  3. Pushed all local changes"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

echo ""
echo "Step 1: Removing .env and .env.local from history..."
git-filter-repo --path .env --path .env.local --invert-paths --force

echo ""
echo "Step 2: Removing all .log files from history..."
git-filter-repo --path-glob '*.log' --invert-paths --force

echo ""
echo "Step 3: Removing log directories from history..."
git-filter-repo --path-glob '**/logs/*' --invert-paths --force

echo ""
echo "=============================================="
echo "Git history has been cleaned!"
echo "=============================================="
echo ""
echo "NEXT STEPS (CRITICAL!):"
echo ""
echo "1. Force push to GitHub:"
echo "   git push --force --all"
echo "   git push --force --tags"
echo ""
echo "2. IMMEDIATELY ROTATE these compromised API keys:"
echo "   - dRPC: https://drpc.org/dashboard"
echo "   - Ankr: https://www.ankr.com/rpc/dashboard"
echo "   - Infura: https://infura.io/dashboard"
echo "   - Alchemy: https://dashboard.alchemy.com/"
echo "   - QuickNode: https://dashboard.quicknode.com/"
echo "   - Helius: https://dev.helius.xyz/dashboard"
echo ""
echo "3. All team members must re-clone or run:"
echo "   git fetch origin"
echo "   git reset --hard origin/main"
echo ""
echo "4. Consider enabling GitHub secret scanning:"
echo "   https://docs.github.com/en/code-security/secret-scanning"
echo ""
