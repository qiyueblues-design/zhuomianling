const strongSentenceEndPattern = /[。！？!?]/;
const secondarySentenceEndPattern = /[、，,；;]/;
const trailingSentenceMarkPattern = /[。！？!?.…~～]/;
const closingSentenceMarkPattern = /[”’」』）》】）\]\}]/;

const secondaryBoundaryMinimumCharacters = 36;
const hardSegmentMaximumCharacters = 80;

function normalizeCumulativeVoiceText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isEnglishPeriodBoundary(text: string, index: number): boolean {
  if (text[index] !== ".") {
    return false;
  }

  const previous = text[index - 1];
  const next = text[index + 1];
  if (previous && next && /\d/.test(previous) && /\d/.test(next)) {
    return false;
  }

  let runStart = index;
  let runEnd = index + 1;
  while (runStart > 0 && text[runStart - 1] === ".") {
    runStart -= 1;
  }
  while (runEnd < text.length && text[runEnd] === ".") {
    runEnd += 1;
  }

  return runEnd - runStart < 3 || index === runEnd - 1;
}

function isStrongBoundary(text: string, index: number): boolean {
  if (strongSentenceEndPattern.test(text[index]) || isEnglishPeriodBoundary(text, index)) {
    return true;
  }

  return text[index] === "…" && (text[index - 1] === "…" || text[index + 1] === "…");
}

function consumeSentenceEnding(text: string, start: number): number {
  let cursor = start;

  while (cursor < text.length && trailingSentenceMarkPattern.test(text[cursor])) {
    cursor += 1;
  }
  while (cursor < text.length && closingSentenceMarkPattern.test(text[cursor])) {
    cursor += 1;
  }

  return cursor;
}

function findNextSegmentEnd(text: string, start: number, flushTail: boolean): number | undefined {
  let segmentCharacters = 0;

  for (let index = start; index < text.length; index += 1) {
    segmentCharacters += 1;
    const character = text[index];

    if (isStrongBoundary(text, index)) {
      const end = consumeSentenceEnding(text, index + 1);
      if (end < text.length || flushTail) {
        return end;
      }
      return undefined;
    }

    if (
      segmentCharacters >= secondaryBoundaryMinimumCharacters &&
      secondarySentenceEndPattern.test(character)
    ) {
      return index + 1;
    }

    if (segmentCharacters >= hardSegmentMaximumCharacters) {
      return index + 1;
    }
  }

  return flushTail && start < text.length ? text.length : undefined;
}

/**
 * Converts a safe cumulative AI field into newly committed speech segments.
 * Input must already have passed through AiStreamNormalizer. Once a segment is
 * returned it is never returned again for the lifetime of this instance.
 */
export class StreamingVoiceCommitter {
  private latestText = "";
  private committedOffset = 0;
  private revisionDetected = false;

  append(cumulativeText: string): string[] {
    if (this.revisionDetected) {
      return [];
    }

    const normalized = normalizeCumulativeVoiceText(cumulativeText);
    if (this.latestText && !normalized.startsWith(this.latestText)) {
      this.revisionDetected = true;
      return [];
    }
    if (normalized.length < this.committedOffset) {
      this.revisionDetected = true;
      return [];
    }

    this.latestText = normalized;
    return this.commitAvailable(false);
  }

  finalize(finalText = this.latestText): string[] {
    if (this.revisionDetected) {
      return [];
    }

    const normalized = normalizeCumulativeVoiceText(finalText);
    if (this.latestText && !normalized.startsWith(this.latestText)) {
      this.revisionDetected = true;
      return [];
    }

    this.latestText = normalized;
    return this.commitAvailable(true);
  }

  hasRevision(): boolean {
    return this.revisionDetected;
  }

  private commitAvailable(flushTail: boolean): string[] {
    const segments: string[] = [];

    while (this.committedOffset < this.latestText.length) {
      const end = findNextSegmentEnd(this.latestText, this.committedOffset, flushTail);
      if (end === undefined) {
        break;
      }

      const segment = this.latestText.slice(this.committedOffset, end).trim();
      this.committedOffset = end;
      if (segment) {
        segments.push(segment);
      }
    }

    return segments;
  }
}
