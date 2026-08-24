import type { ZodType } from "zod";

export function parseStructuredProviderOutput<T>(value: string, schema: ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Provider returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`Provider output failed schema validation: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return result.data;
}

export async function withProviderTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Provider timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
