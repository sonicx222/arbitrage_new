# Secrets Management Guide

**Document Version**: 1.0
**Last Updated**: January 31, 2026
**Status**: MANDATORY

## Executive Summary

This document outlines the mandatory practices for managing secrets (API keys, private keys, credentials) in the arbitrage system. Following these practices is **critical** to prevent unauthorized access and financial loss.

## Table of Contents

1. [Security Incident - January 2026](#security-incident---january-2026)
2. [Secret Categories](#secret-categories)
3. [Local Development](#local-development)
4. [Production Deployment](#production-deployment)
5. [CI/CD Pipeline](#cicd-pipeline)
6. [Key Rotation Schedule](#key-rotation-schedule)
7. [Emergency Procedures](#emergency-procedures)

---

## Security Incident - January 2026

### What Happened
API keys were accidentally committed to the git repository in `.env` files. The following keys were exposed:
- dRPC API Key
- Ankr API Key
- Infura API Key
- Alchemy API Key
- QuickNode API Key
- Helius API Key (Solana)

### Immediate Actions Required
1. **ROTATE ALL EXPOSED KEYS IMMEDIATELY**
2. Run `scripts/cleanup-git-history.sh` to remove from git history
3. Force push to remote repository
4. All team members must re-clone the repository

### Provider Dashboards for Key Rotation
| Provider | Dashboard URL |
|----------|---------------|
| dRPC | https://drpc.org/dashboard |
| Ankr | https://www.ankr.com/rpc/dashboard |
| Infura | https://infura.io/dashboard |
| Alchemy | https://dashboard.alchemy.com/ |
| QuickNode | https://dashboard.quicknode.com/ |
| Helius | https://dev.helius.xyz/dashboard |

---

## Secret Categories

### Category 1: RPC API Keys (MEDIUM Sensitivity)
- dRPC, Ankr, Infura, Alchemy, QuickNode, Helius
- **Risk**: Quota exhaustion, cost overruns
- **Rotation**: Every 90 days or after any exposure

### Category 2: Private Keys (CRITICAL Sensitivity)
- Ethereum wallet private keys
- Cross-chain wallet keys
- **Risk**: Complete loss of funds
- **Rotation**: After any suspected exposure
- **Storage**: Hardware Security Module (HSM) MANDATORY for production

### Category 3: Service Credentials (HIGH Sensitivity)
- Redis passwords, JWT secrets, webhook URLs
- **Risk**: System compromise, data breach
- **Rotation**: Every 30 days

---

## Local Development

### Setup Process

```bash
# 1. Copy the example file
cp .env.example .env.local

# 2. Edit with your development API keys
# Use ONLY free-tier keys for development
nano .env.local

# 3. Verify .env.local is gitignored
git status  # Should NOT show .env.local
```

### What Goes in `.env.local`
- Personal free-tier RPC API keys
- Local Redis connection (localhost:6379)
- Simulation mode settings
- **NEVER**: Production private keys

### Pre-commit Checklist
Before every commit:
```bash
# 1. Check git status for .env files
git status | grep -E "\.env"

# 2. If any .env files appear, remove from staging
git reset HEAD .env .env.local

# 3. Verify .gitignore is working
git check-ignore .env.local  # Should output: .env.local
```

---

## Production Deployment

### Recommended: AWS Secrets Manager

```typescript
// config/secrets.ts
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({ region: "us-east-1" });

export async function getSecret(secretName: string): Promise<string> {
  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await client.send(command);
  return response.SecretString || '';
}

// Usage
const alchemyKey = await getSecret('arbitrage/rpc/alchemy');
const walletKey = await getSecret('arbitrage/wallet/ethereum');
```

### Alternative: HashiCorp Vault

```bash
# Store a secret
vault kv put secret/arbitrage/rpc alchemy_key="xxx" infura_key="yyy"

# Read in application
vault kv get -field=alchemy_key secret/arbitrage/rpc
```

### Environment Variable Injection (Container Deployments)

```yaml
# kubernetes/deployment.yaml
spec:
  containers:
    - name: arbitrage
      env:
        - name: ALCHEMY_API_KEY
          valueFrom:
            secretKeyRef:
              name: rpc-secrets
              key: alchemy-key
        - name: ETHEREUM_PRIVATE_KEY
          valueFrom:
            secretKeyRef:
              name: wallet-secrets
              key: ethereum-key
```

### Private Key Security (HSM)

For production deployments with real funds:

1. **AWS CloudHSM** or **AWS KMS** for key storage
2. Sign transactions on HSM, never export private keys
3. Use AWS IAM for access control

```typescript
// Example: Sign with AWS KMS
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";

const kmsClient = new KMSClient({ region: "us-east-1" });

async function signTransaction(txHash: Buffer, keyId: string): Promise<Buffer> {
  const command = new SignCommand({
    KeyId: keyId,
    Message: txHash,
    MessageType: "DIGEST",
    SigningAlgorithm: "ECDSA_SHA_256",
  });
  const response = await kmsClient.send(command);
  return Buffer.from(response.Signature!);
}
```

---

## CI/CD Pipeline

### GitHub Actions Configuration

```yaml
# .github/workflows/deploy.yml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/GitHubActions
          aws-region: us-east-1

      - name: Deploy with secrets
        env:
          # Secrets from GitHub Secrets
          ALCHEMY_API_KEY: ${{ secrets.ALCHEMY_API_KEY }}
          INFURA_API_KEY: ${{ secrets.INFURA_API_KEY }}
        run: |
          npm run deploy
```

### Setting GitHub Secrets

1. Go to Repository → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add each secret individually

Required secrets:
- `DRPC_API_KEY`
- `ANKR_API_KEY`
- `INFURA_API_KEY`
- `ALCHEMY_API_KEY`
- `QUICKNODE_API_KEY`
- `HELIUS_API_KEY`

### Enable Secret Scanning

1. Go to Repository → Settings → Code security and analysis
2. Enable "Secret scanning"
3. Enable "Push protection" to block commits with secrets

---

## Key Rotation Schedule

| Secret Type | Rotation Frequency | Trigger Events |
|-------------|-------------------|----------------|
| RPC API Keys | Every 90 days | Key exposure, employee departure |
| Private Keys | Never rotate* | Use new wallet if compromised |
| JWT Secrets | Every 30 days | Security incident |
| Redis Password | Every 90 days | Infrastructure change |

*Private keys cannot be "rotated" - if compromised, transfer funds to new wallet immediately.

### Rotation Procedure

1. Generate new credentials in provider dashboard
2. Update secrets manager / environment
3. Deploy new version
4. Verify new credentials work
5. Revoke old credentials
6. Update documentation

---

## Emergency Procedures

### If API Keys Are Exposed

```bash
# 1. Immediately revoke exposed keys in provider dashboards
# 2. Generate new keys
# 3. Update secrets in production
# 4. Clean git history
./scripts/cleanup-git-history.sh
git push --force --all

# 5. Notify team
# 6. Document incident
```

### If Private Keys Are Exposed

**IMMEDIATE ACTION REQUIRED** (within minutes):

1. **Transfer all funds** to a secure wallet immediately
2. Do NOT use the compromised wallet again
3. Generate new wallets
4. Update all deployment configurations
5. Document incident for audit

### Incident Response Contacts

| Role | Contact |
|------|---------|
| Security Lead | [Add contact] |
| DevOps Lead | [Add contact] |
| On-call Engineer | [Add contact] |

---

## Checklist for New Developers

- [ ] Read this entire document
- [ ] Set up `.env.local` from `.env.example`
- [ ] Verify `.env.local` is gitignored
- [ ] Never commit secrets to git
- [ ] Use free-tier keys for development
- [ ] Report any potential exposures immediately

---

## Audit Log

| Date | Action | Performed By |
|------|--------|--------------|
| 2026-01-31 | Initial secrets management policy | Security Team |
| 2026-01-31 | Git history cleanup for .env exposure | Security Team |
