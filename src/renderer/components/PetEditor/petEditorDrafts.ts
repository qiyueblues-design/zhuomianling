import type {
  LocalPetBasicInfoDraft,
  LocalPetEventSettingsDraft,
  PetChatLanguage,
  PetDefinition,
  PetExpressionKey,
  PetExpressionSourceItem,
  PetExpressionSourceKind,
  PetLine,
  PetReplyLength
} from "../../../shared/types/pet";
import { eventLabels } from "./editorNavigation";

export type PersonaChatLanguage = PetChatLanguage;
export type PersonaReplyLength = PetReplyLength;

export function getFileName(filePath?: string): string {
  if (!filePath) {
    return "";
  }

  return filePath.split(/[\\/]/).pop() ?? filePath;
}

export function createBasicInfoDraft(pet: PetDefinition): LocalPetBasicInfoDraft {
  return {
    id: pet.id === "new-pet" ? undefined : pet.id,
    name: pet.name,
    avatarImage: pet.avatarImage,
    description: pet.description === "待设定" ? "" : pet.description,
    role: pet.details.role === "待设定" ? "" : pet.details.role,
    personality: pet.details.personality === "待设定" ? "" : pet.details.personality,
    scenes: pet.details.scenes
  };
}

export function normalizeBasicInfoDraft(draft: LocalPetBasicInfoDraft): string {
  return JSON.stringify({
    ...draft,
    scenes: [...draft.scenes].sort()
  });
}

export function normalizePersonaDraft(draft: {
  personaPrompt: string;
  chatLanguage: PersonaChatLanguage;
  replyLength?: PersonaReplyLength;
}): string {
  return JSON.stringify(draft);
}

export function getMappedExpressionKeys(pet: PetDefinition): PetExpressionKey[] {
  return Object.keys(pet.expressions ?? {}).filter(
    (key) => Boolean(pet.expressions?.[key])
  ) as PetExpressionKey[];
}

export function getMappedExpressionKeysBySourceKind(
  pet: PetDefinition,
  sourceKind: PetExpressionSourceKind
): PetExpressionKey[] {
  return getMappedExpressionKeys(pet).filter(
    (key) => (pet.expressionSourceKinds?.[key] ?? "expression") === sourceKind
  );
}

function sameExpressionSource(
  left: PetExpressionSourceItem | undefined,
  right: PetExpressionSourceItem | undefined
): boolean {
  return Boolean(
    left &&
      right &&
      left.sourceKind === right.sourceKind &&
      left.sourceFileName === right.sourceFileName &&
      String(left.runtimeName ?? "") === String(right.runtimeName ?? "")
  );
}

function resolveEventSourceFromExpression(
  pet: PetDefinition,
  expression: PetExpressionKey | undefined
): PetExpressionSourceItem | undefined {
  if (!expression || !pet.expressions?.[expression]) {
    return undefined;
  }

  const sourceKind = pet.expressionSourceKinds?.[expression] ?? "expression";
  const sourceFileName = pet.expressionSourceFiles?.[expression];
  const runtimeName = pet.expressions[expression];
  const source = pet.expressionSources?.find((item) =>
    sameExpressionSource(item, {
      sourceKind,
      sourceFileName: sourceFileName ?? String(runtimeName),
      runtimeName
    })
  );

  return source ?? (sourceFileName ? { sourceKind, sourceFileName, runtimeName } : undefined);
}

export function createEventSettingsDraft(pet: PetDefinition): LocalPetEventSettingsDraft {
  const mappedExpressionKeys = getMappedExpressionKeys(pet);

  return {
    petId: pet.id,
    events: eventLabels.map((event) => {
      const savedSettings = pet.eventSettings?.[event.id];
      const savedExpression = savedSettings?.expression;
      const expression =
        savedExpression && mappedExpressionKeys.includes(savedExpression)
          ? savedExpression
          : undefined;
      const source = savedSettings?.source ?? resolveEventSourceFromExpression(pet, expression);

      return {
        event: event.id,
        expression,
        expressionDurationMs: savedSettings?.expressionDurationMs ?? event.expressionDurationMs,
        source,
        sourceDurationMs:
          savedSettings?.sourceDurationMs ??
          savedSettings?.expressionDurationMs ??
          event.expressionDurationMs,
        lines: pet.lines?.[event.id] ?? []
      };
    })
  };
}

export function getPetLineText(line: PetLine): string {
  return typeof line === "string" ? line : line.text;
}

export function updatePetLinesText(previousLines: PetLine[], nextText: string): PetLine[] {
  return nextText
    .split(/\r?\n/)
    .map((lineText, index) => {
      const text = lineText.trim();
      const previousLine = previousLines[index];

      if (!text) {
        return undefined;
      }

      if (previousLine && typeof previousLine !== "string") {
        return {
          ...previousLine,
          text
        };
      }

      return text;
    })
    .filter((line): line is PetLine => Boolean(line));
}

export function normalizeEventSettingsDraft(draft: LocalPetEventSettingsDraft): string {
  return JSON.stringify({
    petId: draft.petId,
    events: draft.events.map((event) => ({
      ...event,
      lines: event.lines
        .map((line) => {
          const text = getPetLineText(line).trim();

          return typeof line === "string" ? text : { ...line, text };
        })
        .filter((line) => (typeof line === "string" ? Boolean(line) : Boolean(line.text)))
    }))
  });
}
