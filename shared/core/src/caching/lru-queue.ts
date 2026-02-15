/**
 * O(1) LRU Queue Implementation using Doubly-Linked List + Map.
 *
 * Extracted from hierarchical-cache.ts (Fix #29) for reuse across
 * cache implementations. Uses sentinel nodes for simplified edge-case handling.
 *
 * Operations:
 * - touch(key): Move key to end (most recently used) - O(1)
 * - add(key): Add new key to end - O(1)
 * - evictOldest(): Remove and return oldest key - O(1)
 * - remove(key): Remove specific key - O(1)
 * - has(key): Check if key exists - O(1)
 * - size: Get current size - O(1)
 *
 * @see ADR-005: Hierarchical Cache (L1 eviction)
 * @see T1.4: O(1) LRU Queue Implementation
 */

// =============================================================================
// LRU Node
// =============================================================================

/**
 * Node in the doubly-linked list for LRU tracking.
 * Each node holds a key and pointers to prev/next nodes.
 */
interface LRUNode {
  key: string;
  prev: LRUNode | null;
  next: LRUNode | null;
}

// =============================================================================
// LRU Queue
// =============================================================================

/**
 * O(1) LRU Queue using doubly-linked list + Map.
 *
 * Previous array-based implementation had O(n) indexOf + O(n) splice.
 * This implementation eliminates the O(n) overhead.
 */
export class LRUQueue {
  /** Map from key to node for O(1) lookup */
  private nodeMap: Map<string, LRUNode> = new Map();
  /** Sentinel head node (oldest) */
  private head: LRUNode;
  /** Sentinel tail node (newest) */
  private tail: LRUNode;

  constructor() {
    // Initialize sentinel nodes (simplifies edge case handling)
    this.head = { key: '__HEAD__', prev: null, next: null };
    this.tail = { key: '__TAIL__', prev: null, next: null };
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * Get current queue size.
   */
  get size(): number {
    return this.nodeMap.size;
  }

  /**
   * Check if key exists in queue.
   */
  has(key: string): boolean {
    return this.nodeMap.has(key);
  }

  /**
   * Add new key to end of queue (most recently used).
   * If key already exists, moves it to end.
   */
  add(key: string): void {
    if (this.nodeMap.has(key)) {
      // Key exists, just touch it
      this.touch(key);
      return;
    }

    // Create new node
    const node: LRUNode = { key, prev: null, next: null };

    // Insert before tail (at the end)
    this.insertBeforeTail(node);

    // Add to map
    this.nodeMap.set(key, node);
  }

  /**
   * Move existing key to end of queue (most recently used).
   * O(1) operation.
   */
  touch(key: string): void {
    const node = this.nodeMap.get(key);
    if (!node) return;

    // Remove from current position
    this.removeNode(node);

    // Insert at end
    this.insertBeforeTail(node);
  }

  /**
   * Remove and return the oldest key (from head).
   * Returns null if queue is empty.
   */
  evictOldest(): string | null {
    // Oldest is the node after head sentinel
    const oldest = this.head.next;
    if (!oldest || oldest === this.tail) {
      return null; // Queue is empty
    }

    // Remove from list
    this.removeNode(oldest);

    // Remove from map
    this.nodeMap.delete(oldest.key);

    return oldest.key;
  }

  /**
   * Remove a specific key from queue.
   */
  remove(key: string): boolean {
    const node = this.nodeMap.get(key);
    if (!node) return false;

    this.removeNode(node);
    this.nodeMap.delete(key);
    return true;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.nodeMap.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * Get all keys in order (oldest first).
   * Mainly for debugging/testing.
   */
  keys(): string[] {
    const result: string[] = [];
    let current = this.head.next;
    while (current && current !== this.tail) {
      result.push(current.key);
      current = current.next;
    }
    return result;
  }

  // Private helper: Remove node from its current position
  private removeNode(node: LRUNode): void {
    const prev = node.prev;
    const next = node.next;
    if (prev) prev.next = next;
    if (next) next.prev = prev;
    node.prev = null;
    node.next = null;
  }

  // Private helper: Insert node before tail (at the "newest" end)
  private insertBeforeTail(node: LRUNode): void {
    const prev = this.tail.prev;
    node.prev = prev;
    node.next = this.tail;
    if (prev) prev.next = node;
    this.tail.prev = node;
  }
}
