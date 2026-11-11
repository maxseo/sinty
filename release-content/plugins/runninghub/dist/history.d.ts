export interface Generation {
    id: number;
    taskId: string;
    endpoint: string;
    name: string;
    status: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    error: string;
    payload: string;
    outputs: string;
    coins: string;
    amount: string;
    detail: string;
}
export interface NewGeneration {
    taskId: string;
    endpoint: string;
    name: string;
    status: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    error: string;
    payload: string;
    outputs: string;
    coins: string;
    amount: string;
    detail: string;
}
/** Coins and dollars, when the task response carries them. Absent fields stay empty. */
export declare function moneyOf(raw: unknown): {
    coins: string;
    amount: string;
};
export declare function openHistory(file: string): {
    add(row: NewGeneration): void;
    list(limit?: number): Generation[];
    close(): void;
};
