export function compileSearchRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'Check the pattern syntax.';
    throw new Error(`Invalid regex pattern: ${detail}`);
  }
}
