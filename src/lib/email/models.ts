import type { ModelId } from "./types";

export type ModelDefinition = {
  id: ModelId;
  label: string;
  baseModel: string;
  parameters: string;
  modelfile: string;
  configuredContext: number;
  nativeContext: number;
  description: string;
};

export const modelDefinitions: readonly ModelDefinition[] = [
  {
    id: "qwen3:8b-maxctx",
    label: "Qwen3 8B",
    baseModel: "qwen3:8b",
    parameters: "8B",
    modelfile: "config/models/Qwen3-8B-MaxContext.Modelfile",
    configuredContext: 40_960,
    nativeContext: 40_960,
    description: "Fast bulk triage baseline.",
  },
  {
    id: "qwen3.5:9b-maxctx",
    label: "Qwen3.5 9B",
    baseModel: "qwen3.5:9b",
    parameters: "9B",
    modelfile: "config/models/Qwen3.5-9B-MaxContext.Modelfile",
    configuredContext: 40_960,
    nativeContext: 262_144,
    description: "Newer architecture balanced for judgment and speed.",
  },
  {
    id: "qwen3:14b-maxctx",
    label: "Qwen3 14B",
    baseModel: "qwen3:14b",
    parameters: "14B",
    modelfile: "config/models/Qwen3-14B-MaxContext.Modelfile",
    configuredContext: 40_960,
    nativeContext: 40_960,
    description: "Largest local model for nuanced decisions.",
  },
] as const;

export function getModelDefinition(model: ModelId) {
  return modelDefinitions.find((definition) => definition.id === model)!;
}
