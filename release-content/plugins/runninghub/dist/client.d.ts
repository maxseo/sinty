export interface RhResult {
    taskId: string;
    status: string;
    outputs: {
        url: string;
        outputType: string;
    }[];
    raw: unknown;
}
type FetchResponse = {
    ok: boolean;
    status: number;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
};
export type RhFetch = (url: string, init?: {
    method?: "GET" | "HEAD" | "POST";
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    timeoutMs?: number;
    maxBytes?: number;
}) => Promise<FetchResponse>;
export declare function joinUrl(base: string, path: string): string;
export declare function uploadFile(fetch: RhFetch, base: string, apiKey: string, filePath: string): Promise<string>;
/** RunningHub puts `taskId` on the object or under `data`, and a refusal comes back as HTTP 200 with `errorMessage`. */
export declare function taskIdOf(json: unknown): string;
export declare function apiError(json: unknown): string;
export declare function submitTask(fetch: RhFetch, base: string, apiKey: string, endpoint: string, payload: Record<string, unknown>): Promise<string>;
export declare function queryTask(fetch: RhFetch, base: string, apiKey: string, taskId: string): Promise<{
    status: string;
    raw: unknown;
}>;
export declare function outputsOf(raw: unknown): {
    url: string;
    outputType: string;
}[];
export declare function isTerminal(status: string): boolean;
export declare function pollTask(fetch: RhFetch, base: string, apiKey: string, taskId: string, opts: {
    intervalMs: number;
    timeoutMs: number;
    sleep?: (ms: number) => Promise<void>;
}): Promise<RhResult>;
export {};
