export const MAX_PET_ID_LENGTH = 64;
export const PET_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;

export function isValidPetId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PET_ID_LENGTH &&
    value === value.trim() &&
    PET_ID_PATTERN.test(value)
  );
}

export function assertValidPetId(value: unknown): string {
  if (!isValidPetId(value)) {
    throw new Error(
      `桌宠 ID 无效：只能使用 1-${MAX_PET_ID_LENGTH} 个 Unicode 字母、数字、下划线或短横线，且必须以字母或数字开头。`
    );
  }

  return value;
}
