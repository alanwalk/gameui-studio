/**
 * Reading `magpie mcp image` answers.
 *
 * The tool replies in prose, not JSON: a saved file is mentioned inside a sentence and
 * unfinished work is described as "wait for it with id X". Pulling the right token out
 * of that prose is where generation silently broke before, so it lives here where it
 * can be tested without spawning a process.
 */

export type GeneratedAsset = {
  /** Absolute path on this machine, when the tool reported one. */
  path?: string;
  /** Base64 PNG bytes, when the tool inlined them. */
  base64?: string;
  /** Set when work is still running; poll it with generation_result. */
  pendingId?: string;
  text: string;
  /** The tool reported a failure instead of an image. */
  isError: boolean;
};

/**
 * Magpie writes the id it wants back in prose. The quoted form is what it actually
 * emits; the bare `id <token>` form is only a fallback, and a loose "any long word"
 * match is deliberately NOT used because it mistakes words like `generated-images`
 * for an id.
 */
export function extractPendingId(text: string): string | undefined {
  const quoted = text.match(/id\s*[":\s]\s*"([^"]{4,})"/i);
  if (quoted) return quoted[1];
  const bare = text.match(/\bid\s+([A-Za-z0-9_-]{6,})/i);
  return bare?.[1];
}

/** Phrases Magpie uses when the picture is not finished yet. */
function looksPending(text: string): boolean {
  return /wait|still (?:being )?(?:made|generating|running)|not ready/i.test(text);
}

export function collectContent(result: unknown): GeneratedAsset {
  const content = Array.isArray((result as any)?.content) ? (result as any).content : [];
  const text = content
    .filter((part: any) => part?.type === 'text')
    .map((part: any) => String(part.text ?? ''))
    .join('\n')
    .trim();

  let base64: string | undefined;
  for (const part of content) {
    if (part?.type === 'image' && typeof part.data === 'string') {
      base64 = part.data;
      break;
    }
  }

  const pathMatch = text.match(/([A-Za-z]:\\[^\s"']+\.(?:png|jpg|jpeg|webp))/i);
  const pendingId = !pathMatch && !base64 && looksPending(text) ? extractPendingId(text) : undefined;

  return {
    path: pathMatch?.[1],
    base64,
    pendingId,
    text,
    isError: Boolean((result as any)?.isError),
  };
}
