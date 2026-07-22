import type { AiOutputMode, AiProtocolTier } from "./types/ai";
import type { PetDefinition } from "./types/pet";

export type AiReplyField = "reply" | "moodDelta" | "voiceText" | "emotion";

export const AI_PROMPT_LIMITS = Object.freeze({
  personaCharacters: 16_000,
  expressionDescriptionCharacters: 500,
  expressionDescriptionsTotalCharacters: 8_000,
  conversationMessageCharacters: 16_000,
  conversationTotalCharacters: 64_000,
  systemPromptCharacters: 64_000
});

export interface AiReplyContractOptions {
  tier: AiProtocolTier;
  voiceTextRequired?: boolean;
  emotionKeys?: string[];
}

export interface AiReplyContract {
  tier: AiProtocolTier;
  requiredFields: AiReplyField[];
  allowedFields: AiReplyField[];
  emotionKeys: string[];
  voiceTextRequired: boolean;
  emotionRequired: boolean;
}

function normalizedEmotionKeys(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function getAiProtocolTierForMode(mode: AiOutputMode): AiProtocolTier {
  return mode === "plain-text" ? "text" : "full";
}

export function createAiReplyContract(options: AiReplyContractOptions): AiReplyContract {
  if (options.tier === "text") {
    return {
      tier: "text",
      requiredFields: ["reply"],
      allowedFields: ["reply"],
      emotionKeys: [],
      voiceTextRequired: false,
      emotionRequired: false
    };
  }

  const emotionKeys = normalizedEmotionKeys(options.emotionKeys);
  // Put cross-language speech first so a streaming provider can feed complete
  // sentences to TTS before it spends tokens generating the visible reply.
  const requiredFields: AiReplyField[] = options.voiceTextRequired
    ? ["voiceText", "reply", "moodDelta"]
    : ["reply", "moodDelta"];
  if (emotionKeys.length) requiredFields.push("emotion");

  return {
    tier: "full",
    requiredFields,
    allowedFields: [...requiredFields],
    emotionKeys,
    voiceTextRequired: Boolean(options.voiceTextRequired),
    emotionRequired: emotionKeys.length > 0
  };
}

export function createAiReplyContractForPet(
  pet: PetDefinition | undefined,
  tier: AiProtocolTier
): AiReplyContract {
  const voiceEnabled = Boolean(
    pet?.voiceModelSettings?.enabled && pet.voiceModelSettings.connected
  );
  const voiceTextRequired = voiceEnabled &&
    (pet?.personaSettings?.chatLanguage ?? "zh") !==
      (pet?.voiceModelSettings?.language ?? "zh");
  const emotionKeys = pet?.expressionSelectionMode === "random"
    ? []
    : Object.entries(pet?.expressionDescriptions ?? {})
        .filter(([key, description]) => Boolean(description?.trim()) && Boolean(pet?.expressions?.[key]))
        .map(([key]) => key);

  return createAiReplyContract({ tier, voiceTextRequired, emotionKeys });
}

export function buildAiReplyJsonSchema(contract: AiReplyContract): Record<string, unknown> | undefined {
  if (contract.tier === "text") return undefined;

  const fieldSchemas: Record<AiReplyField, Record<string, unknown>> = {
    reply: {
      type: "string",
      description: "Only words audibly spoken to the user. No thoughts, inner monologue, narration, actions, stage directions, expression notes, or bracketed asides."
    },
    moodDelta: {
      type: "integer",
      minimum: -12,
      maximum: 12,
      description: "Mood change caused by this interaction; use 0 when unchanged. Never mention it in reply."
    },
    voiceText: {
      type: "string",
      description: "Complete spoken translation of reply in the configured voice language, with no added thoughts, narration, actions, or stage directions."
    },
    emotion: {
      type: "string",
      enum: contract.emotionKeys,
      description: "Semantic expression key matching the spoken reply."
    }
  };
  const properties = Object.fromEntries(
    contract.requiredFields.map((field) => [field, fieldSchemas[field]])
  );

  return {
    type: "object",
    properties,
    required: contract.requiredFields,
    additionalProperties: false
  };
}
