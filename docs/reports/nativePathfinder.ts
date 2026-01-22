/**
 * Proposed Rust Native Module Interface for Path Finding
 * To be implemented via Neon or N-API to replace current JS DFS
 */
export interface NativePathFinder {
    // Load graph state into Rust memory (Zero-copy ideally)
    updateGraph(updates: Buffer): void;

    // Execute DFS in C++ speed
    // Returns: [["WETH", "USDC", "UNI", "WETH"], expectedProfit]
    findPaths(
        startToken: string,
        maxHops: number,
        minProfit: number
    ): Promise<Array<[string[], number]>>;
}