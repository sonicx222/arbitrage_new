import { EventEmitter } from 'events';
export interface Task {
    id: string;
    type: string;
    data: any;
    priority: number;
    timeout?: number;
}
export interface TaskResult {
    taskId: string;
    success: boolean;
    result?: any;
    error?: string;
    processingTime: number;
}
export interface WorkerStats {
    workerId: number;
    activeTasks: number;
    completedTasks: number;
    failedTasks: number;
    averageProcessingTime: number;
    uptime: number;
}
export declare class PriorityQueue<T> {
    private items;
    enqueue(item: T, priority: number): void;
    dequeue(): T | undefined;
    peek(): T | undefined;
    size(): number;
    isEmpty(): boolean;
    clear(): void;
}
export declare class EventProcessingWorkerPool extends EventEmitter {
    private workers;
    private availableWorkers;
    private activeTasks;
    private taskQueue;
    private workerStats;
    private isRunning;
    private poolSize;
    private maxQueueSize;
    private taskTimeout;
    constructor(poolSize?: number, maxQueueSize?: number, taskTimeout?: number);
    start(): Promise<void>;
    stop(): Promise<void>;
    submitTask(task: Task): Promise<TaskResult>;
    submitBatchTasks(tasks: Task[]): Promise<TaskResult[]>;
    getPoolStats(): {
        poolSize: number;
        availableWorkers: number;
        activeWorkers: number;
        queuedTasks: number;
        activeTasks: number;
        workerStats: WorkerStats[];
    };
    private initializeWorkers;
    private isDispatching;
    private dispatchTimer;
    private startTaskDispatcher;
    private scheduleNextDispatch;
    private assignTaskToWorker;
    private handleWorkerMessage;
    private handleWorkerError;
    private handleWorkerExit;
    private cleanupWorker;
    private restartWorker;
    getHealthStatus(): {
        healthy: boolean;
        poolSize: number;
        availableWorkers: number;
        activeTasks: number;
        queuedTasks: number;
        averageProcessingTime: number;
    };
}
export declare function getWorkerPool(): EventProcessingWorkerPool;
//# sourceMappingURL=worker-pool.d.ts.map