"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Cross-Chain Detector Service Entry Point
const detector_1 = require("./detector");
const core_1 = require("@arbitrage/core");
const logger = (0, core_1.createLogger)('cross-chain-detector');
async function main() {
    try {
        logger.info('Starting Cross-Chain Detector Service');
        const detector = new detector_1.CrossChainDetectorService();
        await detector.start();
        process.on('SIGTERM', async () => {
            logger.info('Received SIGTERM, shutting down gracefully');
            await detector.stop();
            process.exit(0);
        });
        process.on('SIGINT', async () => {
            logger.info('Received SIGINT, shutting down gracefully');
            await detector.stop();
            process.exit(0);
        });
        logger.info('Cross-Chain Detector Service is running');
    }
    catch (error) {
        logger.error('Failed to start Cross-Chain Detector Service', { error });
        process.exit(1);
    }
}
main().catch((error) => {
    console.error('Unhandled error in Cross-Chain Detector Service:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map