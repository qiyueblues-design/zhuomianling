export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

export function encodePcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  let offset = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

export function calculateAudioLevel(samples: Float32Array): number {
  if (!samples.length) {
    return 0;
  }

  let sum = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }

  return Math.min(1, Math.sqrt(sum / samples.length) * 8);
}

export function mergeAudioChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

export function resampleAudio(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) {
    return samples;
  }

  const ratio = sourceRate / targetRate;
  const outputLength = Math.round(samples.length / ratio);
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, samples.length - 1);
    const weight = sourceIndex - before;
    output[index] = (samples[before] ?? 0) * (1 - weight) + (samples[after] ?? 0) * weight;
  }

  return output;
}
