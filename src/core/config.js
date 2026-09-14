// Config schema, validation, normalization.
// Units (internal): bytes, hours, bytes/s. Inputs are user-facing units, converted once here.

export const TB = 1e12;
export const HOURS_PER_YEAR = 8760;

export class ConfigError extends Error {
  constructor(message, path) {
    super(message);
    this.name = "ConfigError";
    this.path = path;
  }
}

const STRATEGIES = {
  concat: { memberCount: null, usableFactor: () => 1 }, // flexible >= 1
  strip: {
    memberCount: (p) => p.d + p.m,
    usableFactor: (p) => p.d / (p.d + p.m),
  }, // exact
  split: {
    memberCount: (p) => p.n + p.m,
    usableFactor: (p) => p.n / (p.n + p.m),
  }, // exact (v1)
  "strip-split": {
    memberCount: (p) => p.n + p.m,
    usableFactor: (p) => p.n / (p.n + p.m),
  }, // exact (v1)
};

function requireNumber(obj, key, path, { min = 0, exclusive = false } = {}) {
  const v = obj[key];
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    (exclusive ? v <= min : v < min)
  ) {
    throw new ConfigError(
      `${path}.${key} must be a finite number ${exclusive ? ">" : ">="} ${min}`,
      path,
    );
  }
  return v;
}

function validateKind(kind, _id, path) {
  requireNumber(kind, "capacityTB", path, { min: 0, exclusive: true });
  requireNumber(kind, "lambdaBase", path);
  requireNumber(kind, "lambdaRead", path);
  requireNumber(kind, "lambdaWrite", path);
  requireNumber(kind, "ure", path);
  requireNumber(kind, "readBW", path, { min: 0, exclusive: true });
  requireNumber(kind, "writeBW", path, { min: 0, exclusive: true });
  requireNumber(kind, "count", path, { min: 1 }); // integer checked below
  requireNumber(kind, "spares", path);
  if (!Number.isInteger(kind.count) || kind.count < 1)
    throw new ConfigError(`${path}.count must be a positive integer`, path);
  if (!Number.isInteger(kind.spares) || kind.spares < 0)
    throw new ConfigError(
      `${path}.spares must be a non-negative integer`,
      path,
    );
}

function validateNode(node, path, ctx, parentId = "root") {
  if (node && node.node === "kind") {
    const kind = ctx.kinds[node.kind];
    if (!kind)
      throw new ConfigError(
        `${path}.kind references unknown kind '${node.kind}'`,
        path,
      );
    requireNumber(node, "count", path, { min: 1 });
    if (!Number.isInteger(node.count))
      throw new ConfigError(`${path}.count must be an integer`, path);
    ctx.referenced[node.kind] = (ctx.referenced[node.kind] || 0) + node.count;
    return {
      capacityBytes: kind.capacityTB * TB * node.count,
      memberSlots: node.count,
    };
  }
  if (node && node.node === "pool") {
    const s = STRATEGIES[node.strategy];
    if (!s)
      throw new ConfigError(
        `${path}.strategy '${node.strategy}' is not one of ${Object.keys(STRATEGIES).join(", ")}`,
        path,
      );
    if (node.strategy !== "concat") {
      requireNumber(node, "m", path);
      if (!Number.isInteger(node.m) || node.m < 0)
        throw new ConfigError(`${path}.m must be a non-negative integer`, path);
      if (node.strategy === "strip")
        requireNumber(node, "d", path),
          (Number.isInteger(node.d) && node.d >= 1) ||
            throwErr(`${path}.d must be a positive integer`, path);
      if (node.strategy === "split" || node.strategy === "strip-split")
        requireNumber(node, "n", path),
          (Number.isInteger(node.n) && node.n >= 1) ||
            throwErr(`${path}.n must be a positive integer`, path);
    }
    requireNumber(node, "lambdaCC", path);
    if (!Array.isArray(node.members))
      throw new ConfigError(`${path}.members must be an array`, path);
    const expected = s.memberCount ? s.memberCount(node) : null;
    const slots = node.members.reduce((a, m) => {
      if (m && m.node === "kind")
        return a + (Number.isInteger(m.count) ? m.count : NaN);
      return a + 1;
    }, 0);
    if (expected !== null && slots !== expected) {
      throw new ConfigError(
        `${path}: ${node.strategy} requires exactly ${expected} members, got ${slots}`,
        path,
      );
    }
    if (node.members.length < 1)
      throw new ConfigError(`${path}: pool needs at least 1 member`, path);
    let capacity = 0;
    node.members.forEach((m, i) => {
      capacity += validateNode(m, `${path}.members[${i}]`, ctx).capacityBytes;
    });
    return { capacityBytes: capacity };
  }
  throw new ConfigError(`${path} must be a 'kind' or 'pool' node`, path);
}

function throwErr(msg, path) {
  throw new ConfigError(msg, path);
}

export function validate(config) {
  if (!config || typeof config !== "object")
    throw new ConfigError("config must be an object");
  if (config.schemaVersion !== 1)
    throw new ConfigError("config.schemaVersion must be 1");
  if (
    !config.kinds ||
    typeof config.kinds !== "object" ||
    Array.isArray(config.kinds)
  )
    throw new ConfigError("config.kinds must be an object keyed by kind id");
  const kindIds = Object.keys(config.kinds);
  if (kindIds.length === 0)
    throw new ConfigError("config.kinds must define at least one kind");
  for (const id of kindIds) validateKind(config.kinds[id], id, `kinds.${id}`);

  const ctx = { kinds: config.kinds, referenced: {}, kindParent: {} };
  validateNode(config.tree, "tree", ctx);

  // Inventory rule: referenced + spares <= count per kind.
  for (const id of kindIds) {
    const k = config.kinds[id];
    const used = ctx.referenced[id] || 0;
    if (used + k.spares > k.count) {
      throw new ConfigError(
        `kinds.${id}: referenced (${used}) + spares (${k.spares}) exceeds inventory count (${k.count})`,
        `kinds.${id}`,
      );
    }
  }

  const g = config.global || {};
  requireNumber(g, "tOpH", "global");
  requireNumber(g, "tSwapH", "global");
  requireNumber(g, "tProcH", "global");
  requireNumber(g, "rebuildBw", "global", {
    min: 0,
    exclusive: g.contention === false,
  }); // dedicated bw must be positive
  if (typeof g.contention !== "boolean")
    throw new ConfigError("global.contention must be boolean");

  const w = config.workload || {};
  requireNumber(w, "storeTB", "workload", { min: 0, exclusive: true });
  requireNumber(w, "readBps", "workload");
  requireNumber(w, "writeBps", "workload");
  requireNumber(w, "avgFileMB", "workload", { min: 0, exclusive: true });
  requireNumber(w, "horizonY", "workload", { min: 0, exclusive: true });

  const usableBytes = usableBytesOf(config.tree, config.kinds);
  if (w.storeTB * TB > usableBytes) {
    throw new ConfigError(
      `workload.storeTB (${w.storeTB} TB) exceeds usable capacity (${(usableBytes / TB).toFixed(1)} TB)`,
      "workload.storeTB",
    );
  }
  return { usableBytes };
}

// Usable capacity composes top-down: each strategy keeps its data-members' share of the
// aggregate usable bytes its members present. Exported because the UI scales a subtree's workload
// preview by that subtree's share of the top-level usable capacity (ui.md §5).
export function usableBytesOf(node, kinds) {
  if (node.node === "kind")
    return kinds[node.kind].capacityTB * TB * node.count;
  const s = STRATEGIES[node.strategy];
  const sum = node.members.reduce((a, m) => a + usableBytesOf(m, kinds), 0);
  return sum * s.usableFactor(node);
}

export function normalize(config) {
  validate(config);
  return config; // v1: config already in canonical shape; conversions happen at machine build
}
