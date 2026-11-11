/** Enough to open the catalog before the public registry has been downloaded. */
export const SEED = {
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
export function parseRegistry(raw) {
    const body = raw && typeof raw === "object" ? raw : {};
    const models = Array.isArray(body.models) ? body.models.flatMap((row) => {
        const model = normalizeModel(row);
        return model ? [model] : [];
    }) : [];
    return { ...(typeof body.version === "string" ? { version: body.version } : {}), models };
}
/** The public registry uses `class_name` / `display_name`, and a LIST option is `{ value, description }`. */
function normalizeModel(row) {
    if (!row || typeof row !== "object")
        return undefined;
    const rec = row;
    const endpoint = text(rec.endpoint);
    if (!endpoint)
        return undefined;
    const params = Array.isArray(rec.params) ? rec.params.flatMap((p) => {
        const param = normalizeParam(p);
        return param ? [param] : [];
    }) : [];
    const name = text(rec.name_en) || text(rec.display_name);
    const nameCn = text(rec.name_cn);
    const output = text(rec.output_type);
    const category = text(rec.category);
    return {
        id: text(rec.id) || text(rec.class_name) || endpoint,
        endpoint,
        ...(name ? { name_en: name } : {}),
        ...(nameCn ? { name_cn: nameCn } : {}),
        ...(output ? { output_type: output } : {}),
        ...(category ? { category } : {}),
        ...(params.length ? { params } : {}),
    };
}
function normalizeParam(row) {
    if (!row || typeof row !== "object")
        return undefined;
    const rec = row;
    const fieldKey = text(rec.fieldKey);
    const type = text(rec.type);
    if (!fieldKey || !type)
        return undefined;
    const options = Array.isArray(rec.options) ? rec.options.flatMap((opt) => {
        const value = text(opt) || (opt && typeof opt === "object" ? text(opt.value) : "");
        return value ? [value] : [];
    }) : [];
    const description = text(rec.description);
    const fallback = text(rec.defaultValue);
    return {
        fieldKey,
        type,
        ...(rec.required === true ? { required: true } : {}),
        ...(rec.multipleInputs === true ? { multipleInputs: true } : {}),
        ...(options.length ? { options } : {}),
        ...(description ? { description } : {}),
        ...(fallback ? { defaultValue: fallback } : {}),
        ...(typeof rec.maxLength === "number" ? { maxLength: rec.maxLength } : {}),
        ...(typeof rec.maxInputNum === "number" ? { maxInputNum: rec.maxInputNum } : {}),
    };
}
function text(value) {
    return typeof value === "string" ? value : "";
}
export function searchModels(registry, query, outputType, limit = 30) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const kind = outputType.toLowerCase();
    const hits = registry.models.filter((m) => {
        if (kind && (m.output_type ?? m.category ?? "").toLowerCase() !== kind)
            return false;
        if (!words.length)
            return true;
        const hay = `${m.endpoint} ${m.id} ${m.name_en ?? ""} ${m.name_cn ?? ""} ${m.category ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
    });
    return hits.slice(0, limit);
}
export function modelByEndpoint(registry, endpoint) {
    return registry.models.find((m) => m.endpoint === endpoint);
}
/** Rejects names and enum values that are not in the model schema. Unknown fields are refused. */
export function validatePayload(model, payload) {
    const errors = [];
    const known = new Map((model.params ?? []).map((p) => [p.fieldKey, p]));
    for (const key of Object.keys(payload)) {
        if (!known.has(key))
            errors.push({ field: key, message: "нет такого поля в схеме" });
    }
    for (const param of model.params ?? []) {
        const value = payload[param.fieldKey];
        const empty = value === undefined || value === null || value === "";
        if (param.required && empty) {
            errors.push({ field: param.fieldKey, message: "обязательное поле" });
            continue;
        }
        if (empty)
            continue;
        errors.push(...checkType(param, value));
    }
    return errors;
}
function checkType(param, value) {
    const type = param.type.toUpperCase();
    if (type === "LIST") {
        if (typeof value !== "string" || (param.options && !param.options.includes(value))) {
            return [{ field: param.fieldKey, message: "значение не из списка" }];
        }
        return [];
    }
    if (type === "BOOLEAN")
        return typeof value === "boolean" ? [] : [{ field: param.fieldKey, message: "нужен boolean" }];
    if (type === "INT")
        return typeof value === "number" && Number.isInteger(value) ? [] : [{ field: param.fieldKey, message: "нужно целое число" }];
    if (type === "FLOAT")
        return typeof value === "number" ? [] : [{ field: param.fieldKey, message: "нужно число" }];
    if (type === "STRING")
        return typeof value === "string" ? [] : [{ field: param.fieldKey, message: "нужна строка" }];
    if (type === "IMAGE" || type === "VIDEO" || type === "AUDIO") {
        const ok = typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
        return ok ? [] : [{ field: param.fieldKey, message: "нужен адрес файла" }];
    }
    return [];
}
export function cardOf(model) {
    return {
        id: model.id,
        name: model.name_en || model.name_cn || model.endpoint,
        endpoint: model.endpoint,
        outputType: model.output_type ?? "",
        category: model.category ?? "",
    };
}
//# sourceMappingURL=registry.js.map