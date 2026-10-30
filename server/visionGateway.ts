export const GATEWAY = process.env.MAGPIE_GATEWAY ?? 'http://127.0.0.1:3425/v1';
/** Placeholder for the local gateway; remote providers need their own server-side key. */
export const GATEWAY_KEY = process.env.MAGPIE_KEY ?? 'magpie';

export const VISION_MODEL = process.env.MAGPIE_VISION_MODEL ?? 'codex/gpt-6.1-terra';

export async function gatewayChat(messages: unknown[], model: string): Promise<string> {
  const request: Record<string, unknown> = { model, temperature: 0.1, messages };
  if (model === 'codex/gpt-6.1-terra') request.reasoning_effort = 'medium';
  const response = await fetch(`${GATEWAY}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GATEWAY_KEY}`,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Magpie 网关 ${response.status}: ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('视觉模型返回为空');
  return content;
}
