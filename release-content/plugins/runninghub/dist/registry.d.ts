export interface RhParam {
    fieldKey: string;
    type: string;
    required?: boolean;
    options?: string[];
    multipleInputs?: boolean;
    description?: string;
    defaultValue?: string;
    maxLength?: number;
    maxInputNum?: number;
}
export interface RhModel {
    id: string;
    name_en?: string;
    name_cn?: string;
    endpoint: string;
    output_type?: string;
    category?: string;
    params?: RhParam[];
}
export interface RhRegistry {
    version?: string;
    models: RhModel[];
}
/** Enough to open the catalog before the public registry has been downloaded. */
export declare const SEED: RhRegistry;
export declare function parseRegistry(raw: unknown): RhRegistry;
export declare function searchModels(registry: RhRegistry, query: string, outputType: string, limit?: number): RhModel[];
export declare function modelByEndpoint(registry: RhRegistry, endpoint: string): RhModel | undefined;
export interface FieldError {
    field: string;
    message: string;
}
/** Rejects names and enum values that are not in the model schema. Unknown fields are refused. */
export declare function validatePayload(model: RhModel, payload: Record<string, unknown>): FieldError[];
export declare function cardOf(model: RhModel): {
    id: string;
    name: string;
    endpoint: string;
    outputType: string;
    category: string;
};
