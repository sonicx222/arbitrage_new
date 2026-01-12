"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Coordinator Service Entry Point
const coordinator_1 = require("./coordinator");
const src_1 = require("../../../shared/core/src");
const logger = (0, src_1.createLogger)('coordinator');
async function main() {
    try {
        logger.info('Starting Coordinator Service');
        const coordinator = new coordinator_1.CoordinatorService();
        const port = parseInt(process.env.PORT || '3000');
        await coordinator.start(port);
        process.on('SIGTERM', async () => {
            logger.info('Received SIGTERM, shutting down gracefully');
            await coordinator.stop();
            process.exit(0);
        });
        process.on('SIGINT', async () => {
            logger.info('Received SIGINT, shutting down gracefully');
            await coordinator.stop();
            process.exit(0);
        });
        logger.info(`Coordinator Service is running on port ${port}`);
    }
    catch (error) {
        logger.error('Failed to start Coordinator Service', { error });
        process.exit(1);
    }
}
main().catch((error) => {
    console.error('Unhandled error in Coordinator Service:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map