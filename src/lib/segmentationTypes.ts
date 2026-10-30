/** Integer xyxy bounds in the original image; right and bottom are exclusive. */
export type PixelBounds = [number, number, number, number];

export type SegmentationDiagnostics = {
  promptBounds: PixelBounds;
  inferenceBounds: PixelBounds;
  maskBounds: PixelBounds;
  outputBounds: PixelBounds;
  quality: {
    status: 'review' | 'failed';
    issues: { code: string; severity: 'warning' | 'error'; message: string }[];
    removedComponents: number;
    removedPixels: number;
    retainedComponents: number;
  };
  refinement: {
    method: 'pymatting-cf' | 'source-alpha' | 'binary-mask';
    status: 'applied' | 'preserved' | 'degraded';
    reason?: string;
    softAlphaPixels: number;
    changedRgbPixels: number;
    trimapRadius: number;
  };
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pixelBounds(value: unknown, width: number, height: number): value is PixelBounds {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isSafeInteger) &&
    value[0] >= 0 && value[1] >= 0 && value[0] < value[2] && value[1] < value[3] &&
    value[2] <= width && value[3] <= height;
}

function contains(outer: PixelBounds, inner: PixelBounds): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function count(value: unknown, maximum: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Validate both worker replies and persisted diagnostics before using coordinates. */
export function isSegmentationDiagnostics(value: unknown, width: number, height: number): value is SegmentationDiagnostics {
  if (!record(value) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return false;
  const { promptBounds, inferenceBounds, maskBounds, outputBounds, quality, refinement } = value;
  if (!pixelBounds(promptBounds, width, height) || !pixelBounds(inferenceBounds, width, height) ||
      !pixelBounds(maskBounds, width, height) || !pixelBounds(outputBounds, width, height) ||
      !contains(inferenceBounds, promptBounds) || !contains(inferenceBounds, outputBounds) || !contains(outputBounds, maskBounds)) return false;
  const maximum = width * height;
  if (!record(quality) || (quality.status !== 'review' && quality.status !== 'failed') ||
      !Array.isArray(quality.issues) || quality.issues.length > 32 || !quality.issues.every((issue) => record(issue) &&
        typeof issue.code === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(issue.code) &&
        (issue.severity === 'warning' || issue.severity === 'error') && typeof issue.message === 'string' && issue.message.length <= 500) ||
      !count(quality.removedComponents, maximum) || !count(quality.removedPixels, maximum) || !count(quality.retainedComponents, maximum)) return false;
  if (quality.issues.some((issue) => issue.severity === 'error') && quality.status !== 'failed') return false;
  if (!record(refinement) || !['pymatting-cf', 'source-alpha', 'binary-mask'].includes(String(refinement.method)) ||
      !['applied', 'preserved', 'degraded'].includes(String(refinement.status)) ||
      !count(refinement.softAlphaPixels, maximum) || !count(refinement.changedRgbPixels, maximum) || !count(refinement.trimapRadius, 16) ||
      (refinement.reason !== undefined && (typeof refinement.reason !== 'string' || refinement.reason.length > 500))) return false;
  if (refinement.status === 'degraded' && (typeof refinement.reason !== 'string' || !refinement.reason)) return false;
  return (refinement.method === 'pymatting-cf' && refinement.status === 'applied') ||
    (refinement.method === 'source-alpha' && refinement.status === 'preserved') ||
    (refinement.method === 'binary-mask' && refinement.status === 'degraded');
}
