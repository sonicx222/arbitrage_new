# Implementation Plan - Fix Missing Opportunity Publisher

## Goal
Fix a critical data flow break where detected arbitrage opportunities are logged but never published to Redis Streams. This prevents the Coordinator and Execution Engine from acting on profitable trades.

## Context
- **Problem**: `UnifiedChainDetector` detects opportunities and emits events, but `index.ts` only logs them. No data is pushed to `stream:opportunities`.
- **Solution**: Create a dedicated `OpportunityPublisher` and wire it up in the service entry point (`index.ts`) using shared `RedisStreamsClient`.

## Proposed Changes

### 1. [NEW] `services/unified-detector/src/publishers/opportunity.publisher.ts`
Create a publisher class similar to `WhaleAlertPublisher` but for opportunities.
- **Input**: `ArbitrageOpportunity`
- **Output**: Redis `XADD` to `stream:opportunities` (using `RedisStreamsClient.STREAMS.OPPORTUNITIES`)
- **Format**: `StreamMessage` envelope (id, data, metadata).

### 2. [MODIFY] `services/unified-detector/src/publishers/index.ts`
- Export `OpportunityPublisher`.

### 3. [MODIFY] `services/unified-detector/src/index.ts`
Refactor the startup logic to use Dependency Injection:
- Move `detector` instantiation inside `main()` (or keep global but init later? No, `main()` is better).
- Instantiate `RedisStreamsClient` explicitly in `main()`.
- Pass `streamsClient` to `UnifiedChainDetector` (via config).
- Instantiate `OpportunityPublisher` with the same `streamsClient`.
- Subscribe to `detector.on('opportunity')` -> `publisher.publish(...)`.
- Pass `detector` to `createHealthServer`.

## Verification Plan
1.  **Build**: Ensure no TS errors.
2.  **Unit Tests**: Add test for `OpportunityPublisher`.
3.  **Manual Verification**:
    - Run the system locally.
    - Wait for an opportunity (or simulate one).
    - Verify `stream:opportunities` receives the message (using `redis-cli`).
    - Verify `ExecutionEngine` receives the forwarded message from Coordinator.

## Files to Modify
#### [NEW] [opportunity.publisher.ts](file:///Users/pho/DEV/Arbitrage_Bot/arbitrage_new/services/unified-detector/src/publishers/opportunity.publisher.ts)
#### [MODIFY] [index.ts](file:///Users/pho/DEV/Arbitrage_Bot/arbitrage_new/services/unified-detector/src/publishers/index.ts)
#### [MODIFY] [index.ts](file:///Users/pho/DEV/Arbitrage_Bot/arbitrage_new/services/unified-detector/src/index.ts)
