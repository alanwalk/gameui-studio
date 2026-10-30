import type { Style } from '../types';

/**
 * The select is driven by the project's actual values, not a remembered id: editing the
 * prompt or swapping the reference image must stop showing the old style as applied.
 */
export function findMatchingStyle(
  styles: Style[],
  prompt: string,
  image: string | undefined,
): Style | undefined {
  const normalizedImage = image ?? '';
  return styles.find(
    (style) => style.prompt === prompt && (style.image ?? '') === normalizedImage,
  );
}
