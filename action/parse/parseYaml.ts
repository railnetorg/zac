import { LineCounter, parseDocument } from 'yaml';
import type { Document } from 'yaml';

export interface ParsedYaml {
  doc: Document;
  lineCounter: LineCounter;
  source: string;
}

/**
 * Parse a YAML source string with eemeli/yaml, retaining source positions on
 * every node via `LineCounter` + `keepSourceTokens`. The caller decides how to
 * handle `doc.errors` (e.g. Phase 3's `loadAliasFile` throws; the validate
 * phase wraps them in a ZacError with a source location).
 */
export function parseYaml(source: string): ParsedYaml {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, keepSourceTokens: true });
  return { doc, lineCounter, source };
}
