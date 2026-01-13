"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Execution Engine Service Entry Point
const engine_1 = require("./engine");
const core_1 = require("@arbitrage/core");
const logger = (0, core_1.createLogger)('execution-engine');
async function main() {
    try {
        logger.info('Starting Execution Engine Service');
        const engine = new engine_1.ExecutionEngineService();
        await engine.start();
        process.on('SIGTERM', async () => {
            logger.info('Received SIGTERM, shutting down gracefully');
            await engine.stop();
            process.exit(0);
        });
        process.on('SIGINT', async () => {
            logger.info('Received SIGINT, shutting down gracefully');
            await engine.stop();
            process.exit(0);
        });
        logger.info('Execution Engine Service is running');
    }
    catch (error) {
        logger.error('Failed to start Execution Engine Service', { error });
        process.exit(1);
    }
}
main().catch((error) => {
    console.error('Unhandled error in Execution Engine Service:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map