/**
 * Tests for KMS Signer — AWS KMS Transaction Signing Adapter
 *
 * Fix #7: Comprehensive test suite for KMS signer functions including
 * DER signature parsing, SPKI public key parsing, address derivation,
 * s-value normalization, timeout, and circuit breaker.
 *
 * @see Phase 2 Item 27: KMS integration for signing
 */

import { ethers } from 'ethers';
import {
  KmsSigner,
  AwsKmsClient,
  createKmsSigner,
} from '../../../src/services/kms-signer';
import type { KmsClient, KmsSignerConfig } from '../../../src/services/kms-signer';

// =============================================================================
// Test Utilities
// =============================================================================

function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as any;
}

function createMockProvider() {
  return {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }),
    getBlockNumber: jest.fn().mockResolvedValue(18000000),
    getFeeData: jest.fn().mockResolvedValue({
      gasPrice: ethers.parseUnits('20', 'gwei'),
      maxFeePerGas: ethers.parseUnits('30', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
    }),
  } as any;
}

/**
 * Build a real SPKI DER structure for a known secp256k1 public key.
 *
 * SPKI format:
 *   SEQUENCE {
 *     SEQUENCE { OID(1.2.840.10045.2.1), OID(1.3.132.0.10) },
 *     BIT STRING { 0x00, uncompressed_key[65] }
 *   }
 */
function buildSpkiFromUncompressedKey(uncompressedKey: Uint8Array): Uint8Array {
  // AlgorithmIdentifier SEQUENCE: ecPublicKey OID + secp256k1 OID
  const ecPublicKeyOid = new Uint8Array([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
  const secp256k1Oid = new Uint8Array([0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]);

  const algoIdContent = new Uint8Array([...ecPublicKeyOid, ...secp256k1Oid]);
  const algoIdSeq = new Uint8Array([0x30, algoIdContent.length, ...algoIdContent]);

  // BIT STRING: 0x00 (unused bits) + uncompressed key
  const bitStringContent = new Uint8Array([0x00, ...uncompressedKey]);
  const bitString = new Uint8Array([0x03, bitStringContent.length, ...bitStringContent]);

  // Outer SEQUENCE
  const outerContent = new Uint8Array([...algoIdSeq, ...bitString]);
  const spki = new Uint8Array([0x30, outerContent.length, ...outerContent]);

  return spki;
}

/**
 * Build a DER-encoded ECDSA signature from r and s as 32-byte hex strings.
 */
function buildDerSignature(rHex: string, sHex: string): Uint8Array {
  const rBytes = Buffer.from(rHex.replace('0x', ''), 'hex');
  const sBytes = Buffer.from(sHex.replace('0x', ''), 'hex');

  // Add leading 0x00 if high bit set (DER signed integer)
  const rDer = rBytes[0] >= 0x80 ? new Uint8Array([0x00, ...rBytes]) : rBytes;
  const sDer = sBytes[0] >= 0x80 ? new Uint8Array([0x00, ...sBytes]) : sBytes;

  const rTlv = new Uint8Array([0x02, rDer.length, ...rDer]);
  const sTlv = new Uint8Array([0x02, sDer.length, ...sDer]);

  const seqContent = new Uint8Array([...rTlv, ...sTlv]);
  return new Uint8Array([0x30, seqContent.length, ...seqContent]);
}

// Use a known private key to derive a consistent public key and address
const TEST_PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_WALLET = new ethers.Wallet(TEST_PRIVATE_KEY);

// Get the uncompressed public key (04 || x || y)
function getUncompressedPublicKey(): Uint8Array {
  const signingKey = new ethers.SigningKey(TEST_PRIVATE_KEY);
  const pubHex = signingKey.publicKey; // 0x04...
  return ethers.getBytes(pubHex);
}

// =============================================================================
// Mock KMS Client
// =============================================================================

/**
 * Mock KMS client that signs with a known private key.
 */
function createMockKmsClient(privateKey: string = TEST_PRIVATE_KEY): KmsClient {
  const signingKey = new ethers.SigningKey(privateKey);
  const uncompressedKey = getUncompressedPublicKey();
  const spki = buildSpkiFromUncompressedKey(uncompressedKey);

  return {
    getPublicKey: jest.fn().mockResolvedValue(spki),
    sign: jest.fn().mockImplementation(async (_keyId: string, digest: Uint8Array) => {
      // Sign with the known private key and return DER-encoded signature
      const sig = signingKey.sign(digest);
      return buildDerSignature(sig.r, sig.s);
    }),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('KmsSigner', () => {
  let mockKmsClient: KmsClient;
  let mockProvider: any;
  let signer: KmsSigner;

  beforeEach(() => {
    mockKmsClient = createMockKmsClient();
    mockProvider = createMockProvider();

    signer = new KmsSigner({
      keyId: 'test-key-id',
      kmsClient: mockKmsClient,
      provider: mockProvider,
      logger: createMockLogger(),
      chainName: 'ethereum',
    });
  });

  describe('getAddress', () => {
    it('should derive the correct Ethereum address from KMS public key', async () => {
      const address = await signer.getAddress();

      expect(address).toBe(TEST_WALLET.address);
    });

    it('should cache the address after first derivation', async () => {
      const address1 = await signer.getAddress();
      const address2 = await signer.getAddress();

      expect(address1).toBe(address2);
      // getPublicKey should only be called once
      expect(mockKmsClient.getPublicKey).toHaveBeenCalledTimes(1);
    });

    it('should call getPublicKey with the configured keyId', async () => {
      await signer.getAddress();

      expect(mockKmsClient.getPublicKey).toHaveBeenCalledWith('test-key-id');
    });
  });

  describe('signMessage', () => {
    it('should produce a valid EIP-191 signature', async () => {
      const message = 'Hello KMS';
      const signature = await signer.signMessage(message);

      expect(signature).toMatch(/^0x[0-9a-f]+$/i);

      // Verify the signature recovers to our address
      const recovered = ethers.verifyMessage(message, signature);
      expect(recovered.toLowerCase()).toBe(TEST_WALLET.address.toLowerCase());
    });

    it('should call KMS sign with the correct digest', async () => {
      await signer.signMessage('test');

      expect(mockKmsClient.sign).toHaveBeenCalled();
      const [keyId, digest] = (mockKmsClient.sign as jest.Mock).mock.calls[0];
      expect(keyId).toBe('test-key-id');
      expect(digest).toBeInstanceOf(Uint8Array);
      expect(digest.length).toBe(32);
    });
  });

  describe('signTransaction', () => {
    it('should sign a basic transaction', async () => {
      const tx: ethers.TransactionLike = {
        to: '0x0000000000000000000000000000000000000001',
        value: ethers.parseEther('0.01'),
        gasLimit: 21000,
        gasPrice: ethers.parseUnits('20', 'gwei'),
        nonce: 0,
        chainId: 1,
        type: 0,
      };

      const serialized = await signer.signTransaction(tx);

      expect(serialized).toMatch(/^0x/);
      // Parse the signed transaction to verify structure
      const parsed = ethers.Transaction.from(serialized);
      expect(parsed.to?.toLowerCase()).toBe('0x0000000000000000000000000000000000000001');
    });
  });

  describe('signTypedData', () => {
    it('should sign EIP-712 typed data', async () => {
      const domain: ethers.TypedDataDomain = {
        name: 'Test',
        version: '1',
        chainId: 1,
      };
      const types = {
        Mail: [
          { name: 'contents', type: 'string' },
        ],
      };
      const value = { contents: 'Hello' };

      const signature = await signer.signTypedData(domain, types, value);

      expect(signature).toMatch(/^0x[0-9a-f]+$/i);
    });
  });

  describe('connect', () => {
    it('should return a new signer with a different provider', () => {
      const newProvider = createMockProvider();
      const newSigner = signer.connect(newProvider);

      expect(newSigner).toBeInstanceOf(KmsSigner);
      expect(newSigner).not.toBe(signer);
    });

    it('should use original provider when null is passed', () => {
      const newSigner = signer.connect(null);
      expect(newSigner).toBeInstanceOf(KmsSigner);
    });
  });

  describe('Fix #41: KMS timeout', () => {
    it('should throw on KMS sign timeout', async () => {
      const slowKmsClient: KmsClient = {
        getPublicKey: (mockKmsClient.getPublicKey as jest.Mock),
        sign: jest.fn().mockImplementation(() => {
          return new Promise((resolve) => {
            // Never resolves within timeout
            setTimeout(() => resolve(new Uint8Array()), 60000);
          });
        }),
      };

      const timeoutSigner = new KmsSigner({
        keyId: 'test-key-id',
        kmsClient: slowKmsClient,
        provider: mockProvider,
        logger: createMockLogger(),
        chainName: 'ethereum',
        kmsTimeoutMs: 50, // 50ms timeout for testing
      });

      await expect(timeoutSigner.signMessage('test')).rejects.toThrow('ERR_KMS_TIMEOUT');
    });
  });

  describe('Fix #41: Circuit breaker', () => {
    it('should open circuit after MAX_CONSECUTIVE_FAILURES', async () => {
      const failingKmsClient: KmsClient = {
        getPublicKey: (mockKmsClient.getPublicKey as jest.Mock),
        sign: jest.fn().mockRejectedValue(new Error('KMS unavailable')),
      };

      const cbSigner = new KmsSigner({
        keyId: 'test-key-id',
        kmsClient: failingKmsClient,
        provider: mockProvider,
        logger: createMockLogger(),
        chainName: 'ethereum',
      });

      // Trigger 5 consecutive failures
      for (let i = 0; i < 5; i++) {
        await expect(cbSigner.signMessage('test')).rejects.toThrow('KMS unavailable');
      }

      // 6th call should immediately fail with circuit breaker open
      await expect(cbSigner.signMessage('test')).rejects.toThrow('ERR_KMS_CIRCUIT_OPEN');

      // Verify KMS was only called 5 times (not 6)
      expect(failingKmsClient.sign).toHaveBeenCalledTimes(5);
    });
  });
});

describe('createKmsSigner', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return null when no KMS key is configured', () => {
    delete process.env.KMS_KEY_ID;
    delete process.env.KMS_KEY_ID_ETHEREUM;

    const result = createKmsSigner(
      'ethereum',
      createMockProvider(),
      createMockLogger(),
    );

    expect(result).toBeNull();
  });

  it('should use per-chain key when available', () => {
    process.env.KMS_KEY_ID = 'default-key';
    process.env.KMS_KEY_ID_ETHEREUM = 'ethereum-specific-key';

    const mockClient = createMockKmsClient();
    const result = createKmsSigner(
      'ethereum',
      createMockProvider(),
      createMockLogger(),
      mockClient,
    );

    expect(result).toBeInstanceOf(KmsSigner);
  });

  it('should fall back to generic KMS_KEY_ID when per-chain key not set', () => {
    process.env.KMS_KEY_ID = 'default-key';
    delete process.env.KMS_KEY_ID_ARBITRUM;

    const mockClient = createMockKmsClient();
    const result = createKmsSigner(
      'arbitrum',
      createMockProvider(),
      createMockLogger(),
      mockClient,
    );

    expect(result).toBeInstanceOf(KmsSigner);
  });
});

describe('SPKI parsing (Fix #13)', () => {
  it('should correctly parse a valid SPKI structure', async () => {
    const uncompressedKey = getUncompressedPublicKey();
    const spki = buildSpkiFromUncompressedKey(uncompressedKey);

    const mockClient: KmsClient = {
      getPublicKey: jest.fn().mockResolvedValue(spki),
      sign: jest.fn().mockResolvedValue(new Uint8Array(70)),
    };

    const signer = new KmsSigner({
      keyId: 'test-key-id',
      kmsClient: mockClient,
      provider: createMockProvider(),
      logger: createMockLogger(),
    });

    const address = await signer.getAddress();
    expect(address).toBe(TEST_WALLET.address);
  });

  it('should reject invalid SPKI (missing SEQUENCE tag)', async () => {
    const badSpki = new Uint8Array([0x01, 0x00]); // Not a SEQUENCE

    const mockClient: KmsClient = {
      getPublicKey: jest.fn().mockResolvedValue(badSpki),
      sign: jest.fn(),
    };

    const signer = new KmsSigner({
      keyId: 'test-key-id',
      kmsClient: mockClient,
      provider: createMockProvider(),
      logger: createMockLogger(),
    });

    await expect(signer.getAddress()).rejects.toThrow('Invalid SPKI');
  });
});
