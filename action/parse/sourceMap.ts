import type { ParsedYaml } from './parseYaml';

export interface SourceLoc {
  file: string;
  line: number;
  col: number;
}

/**
 * Walk a parsed YAML document to the node at `path` and return its
 * `{ file, line, col }` source location. Returns `null` when the path does not
 * resolve or the resolved node has no recorded byte range (caller falls back
 * to a file-only location).
 */
export function sourceMap(
  parsed: ParsedYaml,
  path: (string | number)[],
  file: string,
): SourceLoc | null {
  // `Document.getIn(path, true)` returns the underlying scalar/map/seq node
  // with its `range: [start, valueEnd, nodeEnd]` triple. Cast through unknown
  // because the public type is `unknown`/`any` and we only need the `range`.
  const node = parsed.doc.getIn(path, true) as
    | { range?: [number, number, number] | null }
    | null
    | undefined;
  if (!node || !node.range) return null;
  const offset = node.range[0];
  const pos = parsed.lineCounter.linePos(offset);
  return { file, line: pos.line, col: pos.col };
}
