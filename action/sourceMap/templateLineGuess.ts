export interface TemplateLineGuessInput {
  renderedPath: string;
  renderedLine: number; // 1-indexed
  renderedText: string;
  templatePath: string;
  templateText: string;
  /** Minimum substring length floor (UTF-16 code units). Default 8. */
  floor?: number;
}

export interface TemplateLineGuessResult {
  file: string;
  line: number | null;
  note?: string;
}

const DEFAULT_FLOOR = 8;

/**
 * Best-effort guess of the template line that produced a given rendered line.
 *
 * Algorithm (per plan §11, Phase 7.1):
 *   1. Trim the target rendered line. If empty -> fallback.
 *   2. Scan substrings of the trimmed rendered line from longest down to `floor`,
 *      looking for one that
 *        (a) does NOT appear in any OTHER rendered line of the same file, and
 *        (b) appears in exactly one template line.
 *      Return that template line.
 *   3. If no such substring is found -> fallback with a note pointing at the
 *      rendered location.
 *
 * The combined uniqueness + template-presence check is what makes the heuristic
 * useful: a unique-in-rendered substring that doesn't exist in the template at
 * all (e.g. an interpolated address) cannot map to a source line, so we keep
 * shrinking until we hit the surrounding literal template text.
 */
export function templateLineGuess(input: TemplateLineGuessInput): TemplateLineGuessResult {
  const floor = input.floor ?? DEFAULT_FLOOR;
  const renderedLines = input.renderedText.split('\n');
  const idx = input.renderedLine - 1;
  if (idx < 0 || idx >= renderedLines.length) {
    return makeFallback(input);
  }
  const targetLine = renderedLines[idx]!.trim();
  if (targetLine.length === 0) return makeFallback(input);

  const otherLinesText = renderedLines.filter((_, i) => i !== idx).join('\n');
  const templateLines = input.templateText.split('\n');

  // Try substrings of targetLine from longest down to `floor`. Return the first
  // (longest) substring that is unique in rendered AND appears in exactly one
  // template line.
  for (let len = targetLine.length; len >= floor; len--) {
    for (let start = 0; start + len <= targetLine.length; start++) {
      const sub = targetLine.slice(start, start + len);
      if (otherLinesText.includes(sub)) continue;
      const matches: number[] = [];
      for (let i = 0; i < templateLines.length; i++) {
        if (templateLines[i]!.includes(sub)) matches.push(i + 1); // 1-indexed
      }
      if (matches.length === 1) {
        return { file: input.templatePath, line: matches[0]! };
      }
    }
  }

  return makeFallback(input);
}

function makeFallback(input: TemplateLineGuessInput): TemplateLineGuessResult {
  return {
    file: input.templatePath,
    line: null,
    note: `could not uniquely map to template line; check rendered output at ${input.renderedPath}:${input.renderedLine}`,
  };
}
