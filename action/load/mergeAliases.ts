import { warn } from '../warn';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface MergeContext {
  namespace: string;
  pathSoFar: string[];
  sourceA: string;
  sourceB: string;
}

/** Deep merge `b` into `a` (last-wins). Emits a warn() per leaf override. */
export function deepMergeWithWarn(a: unknown, b: unknown, ctx: MergeContext): unknown {
  if (!isPlainObject(a) || !isPlainObject(b)) {
    if (a !== undefined) {
      warn(
        `alias override at ${ctx.namespace}.${ctx.pathSoFar.join('.')}: ${ctx.sourceA} -> ${ctx.sourceB}`,
      );
    }
    return b;
  }
  const out: Record<string, unknown> = { ...a };
  for (const [k, vb] of Object.entries(b)) {
    if (k in out) {
      out[k] = deepMergeWithWarn(out[k], vb, {
        namespace: ctx.namespace,
        pathSoFar: [...ctx.pathSoFar, k],
        sourceA: ctx.sourceA,
        sourceB: ctx.sourceB,
      });
    } else {
      out[k] = vb;
    }
  }
  return out;
}

export interface MergeNamespaceOpts {
  namespace: string;
  files: { path: string; data: unknown }[];
}

/** Merge a list of alias files (one namespace) in order, last-wins, with warnings. */
export function mergeNamespace(opts: MergeNamespaceOpts): unknown {
  if (opts.files.length === 0) return {};
  let acc: unknown = opts.files[0]!.data ?? {};
  let accSource = opts.files[0]!.path;
  for (let i = 1; i < opts.files.length; i++) {
    const f = opts.files[i]!;
    acc = deepMergeWithWarn(acc, f.data ?? {}, {
      namespace: opts.namespace,
      pathSoFar: [],
      sourceA: accSource,
      sourceB: f.path,
    });
    accSource = f.path;
  }
  return acc;
}

export interface MergeGlobalNetworkOpts {
  namespace: string;
  globalData: unknown;
  networkData: unknown;
  globalSource: string;
  networkSource: string;
}

/** Merge `global` and `<network>` entries for one namespace; network wins. */
export function mergeGlobalNetwork(opts: MergeGlobalNetworkOpts): unknown {
  return deepMergeWithWarn(opts.globalData ?? {}, opts.networkData ?? {}, {
    namespace: opts.namespace,
    pathSoFar: [],
    sourceA: opts.globalSource,
    sourceB: opts.networkSource,
  });
}
