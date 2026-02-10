# Node.js Version Switch Guide - Windows

**Current Issue**: Node.js v25.5.0 is incompatible with Hardhat
**Required**: Node.js v20.x LTS

---

## Quick Reference

**Current Node.js**: v25.5.0 (incompatible)
**Target Node.js**: v20.11.1 (LTS)
**Installation Location**: `C:\Program Files\nodejs\`

---

## Option 1: Install nvm-windows (Recommended)

### Advantages
- ✅ Switch between Node versions easily
- ✅ Keep multiple Node versions installed
- ✅ Best for development work
- ✅ No need to reinstall when switching versions

### Installation

1. **Download nvm-windows**:
   ```
   https://github.com/coreybutler/nvm-windows/releases
   ```
   - Download `nvm-setup.exe` (latest release)
   - Run the installer
   - Follow installation prompts

2. **After installation, close and reopen your terminal**

3. **Install Node.js v20.11.1**:
   ```powershell
   nvm install 20.11.1
   nvm use 20.11.1
   node --version  # Should show v20.11.1
   ```

4. **Set as default** (optional):
   ```powershell
   nvm alias default 20.11.1
   ```

### Usage

Switch between versions anytime:
```powershell
nvm list              # Show installed versions
nvm use 20.11.1       # Switch to v20.11.1
nvm use 25.5.0        # Switch back to v25.5.0 if needed
nvm current           # Show current version
```

---

## Option 2: Direct Install (Simpler)

### Advantages
- ✅ Simpler installation process
- ✅ No additional tools required
- ✅ Standard Windows installation

### Disadvantages
- ⚠️ Replaces current Node.js v25.5.0
- ⚠️ Cannot easily switch between versions
- ⚠️ Need to reinstall if you want to go back

### Installation

1. **Download Node.js v20.x LTS**:
   ```
   https://nodejs.org/en/download/
   ```
   - Select "LTS" (Long Term Support) tab
   - Download Windows Installer (.msi) for x64
   - Current LTS version: v20.11.1

2. **Run the installer**:
   - Double-click the downloaded `.msi` file
   - Follow installation wizard
   - It will automatically replace v25.5.0

3. **Verify installation**:
   ```powershell
   node --version  # Should show v20.11.1
   npm --version   # Should show corresponding npm version
   ```

---

## After Installing Node.js v20.x

### Step 1: Verify Node Version

```powershell
node --version
# Expected: v20.11.1 (or any v20.x.x)
```

If it still shows v25.5.0:
- Close and reopen your terminal
- Check that `C:\Program Files\nodejs\` is in your PATH
- Restart VSCode if you're using the integrated terminal

---

### Step 2: Reinstall Dependencies

Navigate to contracts folder and reinstall dependencies with the correct Node version:

```powershell
cd c:\Users\kj2bn8f\arbitrage_new\contracts
npm install
```

This ensures all native modules are compiled with Node.js v20.x.

---

### Step 3: Compile Contracts

```powershell
npx hardhat compile
```

**Expected output**: Successfully compiled contracts (no errors)

If successful, you should see:
```
Compiled X Solidity files successfully
```

---

### Step 4: Run Tests

```powershell
# Run all tests
npm test

# Or run specific test files
npm test -- test/FlashLoanArbitrage.test.ts
npm test -- test/SyncSwapFlashArbitrage.test.ts
npm test -- test/CommitRevealArbitrage.test.ts
```

---

## Troubleshooting

### Issue: "nvm: command not found" after installing nvm-windows

**Solution**: Close and reopen your terminal. nvm-windows adds itself to PATH during installation.

---

### Issue: Node version still shows v25.5.0 after installation

**Solutions**:
1. Close and reopen terminal
2. Check PATH environment variable:
   ```powershell
   $env:PATH -split ';' | Select-String nodejs
   ```
3. Restart computer (if PATH changes don't take effect)

---

### Issue: "npm ERR! Unsupported platform" after switching Node versions

**Solution**: Delete `node_modules` and reinstall:
```powershell
cd c:\Users\kj2bn8f\arbitrage_new\contracts
Remove-Item -Recurse -Force node_modules
Remove-Item -Force package-lock.json
npm install
```

---

### Issue: Permission denied when installing nvm-windows

**Solution**: Run the installer as Administrator:
- Right-click `nvm-setup.exe`
- Select "Run as administrator"

---

## Verification Checklist

After switching Node versions, verify everything works:

- [ ] Node.js version is v20.x: `node --version`
- [ ] npm version is compatible: `npm --version`
- [ ] Dependencies reinstalled: `cd contracts && npm install`
- [ ] Contracts compile: `npx hardhat compile`
- [ ] Tests run: `npm test`

---

## Quick Commands Summary

**For nvm-windows users**:
```powershell
nvm install 20.11.1          # Install Node.js v20.11.1
nvm use 20.11.1              # Switch to v20.11.1
node --version               # Verify version
cd contracts                 # Navigate to contracts
npm install                  # Reinstall dependencies
npx hardhat compile          # Compile contracts
npm test                     # Run tests
```

**For direct install users**:
```powershell
# After installing Node.js v20.x from nodejs.org:
node --version               # Verify version
cd contracts                 # Navigate to contracts
npm install                  # Reinstall dependencies
npx hardhat compile          # Compile contracts
npm test                     # Run tests
```

---

## Related Documentation

- [COMPILATION_BLOCKER.md](./COMPILATION_BLOCKER.md) - Details on the Node.js incompatibility
- [BUG_FIXES_SUMMARY.md](./BUG_FIXES_SUMMARY.md) - All bug fixes applied
- [ALL_FIXES_COMPLETE.md](./ALL_FIXES_COMPLETE.md) - Comprehensive fix summary

---

**Last Updated**: 2025-02-10
**Node.js Requirement**: v20.x LTS (for Hardhat compatibility)
**Current Blocker**: Node.js v25.5.0 incompatibility with Hardhat's undici dependency
