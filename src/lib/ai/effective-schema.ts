import type { AiFeaturesConfig, AiOutputSchema } from "./config-types";

/** Single contract for prompting, production parsing and configuration tests. */
export function effectiveOutputSchema(schema: AiOutputSchema, features: AiFeaturesConfig): AiOutputSchema {
  return schema.map(field => {
    const feature = features[field.name];
    return {
      ...field,
      enabled: field.enabled && feature?.enabled === true,
      min: field.type === "number" ? Math.max(field.min ?? 0, feature?.scaleMin ?? 0) : field.min,
      max: field.type === "number" ? Math.min(field.max ?? 100, feature?.scaleMax ?? 100) : field.max,
    };
  });
}
