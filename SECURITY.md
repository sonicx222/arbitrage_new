# Security Policy

## Known Security Issues (Dev Dependencies)

### Status: Acceptable Risk (Dev-Only Tools)

The following vulnerabilities exist in development dependencies and are accepted as low risk:

**Total**: 39 vulnerabilities (34 low, 5 moderate)

### Moderate Severity Issues

1. **lodash** (<4.17.21) - Prototype Pollution
   - Affected: @nomicfoundation/ignition-core (Hardhat tooling)
   - Impact: Dev-only, not in production runtime
   - Fix: Requires breaking changes to Hardhat toolchain
   - Status: Accepted (awaiting upstream fixes)

### Low Severity Issues

1. **elliptic** - Cryptographic Primitive with Risky Implementation
   - Affected: @ethersproject/* (ethers.js v5)
   - Impact: Dev-only contract testing
   - Fix: No fix available (upstream issue)
   - Status: Accepted (not used in production)

2. **cookie** (<0.7.0) - Out of bounds characters
   - Affected: @sentry/node (Hardhat dependency)
   - Mitigation: Overrides configured in package.json
   - Status: Partially mitigated

3. **tmp** - Insecure Temporary File
   - Affected: solc (Solidity compiler)
   - Impact: Dev-only contract compilation
   - Fix: No fix available
   - Status: Accepted (dev tool only)

4. **@inquirer/prompts** - Dependency vulnerability
   - Affected: @stryker-mutator/* (mutation testing)
   - Impact: Dev-only testing tool
   - Status: Accepted (optional dev tool)

### Mitigation Strategy

1. **Overrides Configured**: package.json overrides update cookie, undici, tar, glob, etc.
2. **Scope Limited**: All vulnerabilities are in devDependencies
3. **Production Isolated**: None affect runtime dependencies
4. **Monitoring**: Regular `npm audit` checks
5. **Upstream Tracking**: Monitoring for Hardhat/ethers.js updates

### Production Security

Production runtime dependencies have NO vulnerabilities.

Runtime dependencies:
- ethers@^6.16.0 (not affected - uses v6, vulnerabilities in v5)
- Other core dependencies are clean

### Reporting Security Issues

If you discover a security vulnerability in production code, please report it to:
[Your security contact email]

Do NOT open public issues for security vulnerabilities.

### Update Policy

- Monthly: Check for security updates
- Quarterly: Evaluate breaking changes to resolve dev tool vulnerabilities
- Immediate: Any HIGH or CRITICAL severity in production dependencies

Last Updated: 2026-02-08
