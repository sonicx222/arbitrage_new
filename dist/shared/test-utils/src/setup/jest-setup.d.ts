/**
 * Jest Setup File
 *
 * This file runs before each test file.
 * Configure in jest.config.js: setupFilesAfterEnv: ['<rootDir>/shared/test-utils/src/setup/jest-setup.ts']
 *
 * @see docs/TEST_ARCHITECTURE.md
 */
import '@jest/globals';
declare global {
    namespace jest {
        interface Matchers<R> {
            toBeWithinRange(floor: number, ceiling: number): R;
            toBeValidAddress(): R;
            toBeValidTxHash(): R;
            toCompleteWithin(timeoutMs: number): Promise<R>;
            toBeApproximately(expected: number, precision?: number): R;
        }
    }
}
//# sourceMappingURL=jest-setup.d.ts.map