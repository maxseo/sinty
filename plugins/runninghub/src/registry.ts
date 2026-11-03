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
export const SEED: RhRegistry = {
  version: "seed",
  models: [
    {
      id: "rhart-image-v1-text-to-image",
      name_en: "nano-banana/text-to-image-channel-low-price",
      endpoint: "rhart-image-v1/text-to-image",
      output_type: "image",
      category: "image",
      params: [
        { fieldKey: "prompt", type: "STRING", required: true, description: "Text prompt", maxLength: 20000 },
        { fieldKey: "aspectRatio", type: "LIST", required: true, defaultValue: "3:4", options: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] },
      ],
    },
    {
      id: "rhart-image-v1-edit",
      name_en: "nano-banana/edit-channel-low-price",
      endpoint: "rhart-image-v1/edit",
      output_type: "image",
      category: "image",
      params: [
        { fieldKey: "prompt", type: "STRING", required: true, maxLength: 20000 },
        { fieldKey: "aspectRatio", type: "LIST", required: true, defaultValue: "auto", options: ["auto", "1:1", "16:9", "9:16"] },
        { fieldKey: "imageUrls", type: "IMAGE", required: true, multipleInputs: true, maxInputNum: 5 },
      ],
    },
  ],
};

export function parseRegistry(raw: unknown): RhRegistry {
  const body = raw && typeof raw === "object" ? raw as { version?: unknown; models?: unknown } : {};
  const models = Array.isArray(body.models) ? body.models.filter(isModel) : [];
  return { ...(typeof body.version === "string" ? { version: body.version } : {}), models };
}

function isModel(row: unknown): row is RhModel {
  if (!row || typeof row !== "object") return false;
  const m = row as { endpoint?: unknown; id?: unknown };
  return typeof m.endpoint === "string" && m.endpoint.length > 0 && typeof m.id === "string";
}

export function searchModels(registry: RhRegistry, query: string, outputType: string, limit = 30): RhModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const kind = outputType.toLowerCase();
  const hits = registry.models.filter((m) => {
    if (kind && (m.output_type ?? m.category ?? "").toLowerCase() !== kind) return false;
    if (!words.length) return true;
    const hay = `${m.endpoint} ${m.id} ${m.name_en ?? ""} ${m.name_cn ?? ""} ${m.category ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return hits.slice(0, limit);
}

export function modelByEndpoint(registry: RhRegistry, endpoint: string): RhModel | undefined {
  return registry.models.find((m) => m.endpoint === endpoint);
}

export interface FieldError { field: string; message: string }

/** Rejects names and enum values that are not in the model schema. Unknown fields are refused. */
export function validatePayload(model: RhModel, payload: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];
  const known = new Map((model.params ?? []).map((p) => [p.fieldKey, p]));
  for (const key of Object.keys(payload)) {
    if (!known.has(key)) errors.push({ field: key, message: "нет такого поля в схеме" });
  }
  for (const param of model.params ?? []) {
    const value = payload[param.fieldKey];
    const empty = value === undefined || value === null || value === "";
    if (param.required && empty) {
      errors.push({ field: param.fieldKey, message: "обязательное поле" });
      continue;
    }
    if (empty) continue;
    errors.push(...checkType(param, value));
  }
  return errors;
}

function checkType(param: RhParam, value: unknown): FieldError[] {
  const type = param.type.toUpperCase();
  if (type === "LIST") {
    if (typeof value !== "string" || (param.options && !param.options.includes(value))) {
      return [{ field: param.fieldKey, message: "значение не из списка" }];
    }
    return [];
  }
  if (type === "BOOLEAN") return typeof value === "boolean" ? [] : [{ field: param.fieldKey, message: "нужен boolean" }];
  if (type === "INT") return typeof value === "number" && Number.isInteger(value) ? [] : [{ field: param.fieldKey, message: "нужно целое число" }];
  if (type === "FLOAT") return typeof value === "number" ? [] : [{ field: param.fieldKey, message: "нужно число" }];
  if (type === "STRING") return typeof value === "string" ? [] : [{ field: param.fieldKey, message: "нужна строка" }];
  if (type === "IMAGE" || type === "VIDEO" || type === "AUDIO") {
    const ok = typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
    return ok ? [] : [{ field: param.fieldKey, message: "нужен адрес файла" }];
  }
  return [];
}

export function cardOf(model: RhModel): { id: string; name: string; endpoint: string; outputType: string; category: string } {
  return {
    id: model.id,
    name: model.name_en || model.name_cn || model.endpoint,
    endpoint: model.endpoint,
    outputType: model.output_type ?? "",
    category: model.category ?? "",
  };
}
