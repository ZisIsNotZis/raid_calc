import { describe, it, expect } from "vitest";
import { createStore, downloadConfig, readConfigFile } from "../src/ui/app.js";
import {
  connectDiskToPool,
  addPool,
  walkPools,
  resolvePath,
  setPath,
} from "../src/ui/canvas.js";
import { linePath, logScale, linearScale, logTicks } from "../src/ui/charts.js";

const sampleConfig = () => ({
  schemaVersion: 1,
  kinds: {
    hdd8: {
      capacityTB: 8,
      lambdaBase: 2.8e-6,
      lambdaRead: 0,
      lambdaWrite: 0,
      ure: 0,
      readBW: 190e6,
      writeBW: 170e6,
      count: 12,
      spares: 1,
    },
  },
  tree: {
    node: "pool",
    strategy: "strip",
    d: 3,
    m: 1,
    lambdaCC: 0,
    members: [{ node: "kind", kind: "hdd8", count: 4 }],
  },
  global: {
    tOpH: 12,
    tSwapH: 0.167,
    tProcH: 48,
    rebuildBw: 150e6,
    contention: true,
  },
  workload: { storeTB: 20, readBps: 0, writeBps: 0, avgFileMB: 8, horizonY: 5 },
});

describe("state store", () => {
  it("get returns a deep clone (immutability)", () => {
    const store = createStore(sampleConfig());
    const c1 = store.get();
    c1.workload.storeTB = 99;
    expect(store.get().workload.storeTB).toBe(20);
  });

  it("set records undo history and redo restores", () => {
    const store = createStore(sampleConfig());
    store.set((c) => ({ ...c, workload: { ...c.workload, storeTB: 30 } }));
    expect(store.get().workload.storeTB).toBe(30);
    expect(store.canUndo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.get().workload.storeTB).toBe(20);
    expect(store.canRedo()).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.get().workload.storeTB).toBe(30);
  });

  it("set with recordHistory=false does not create an undo entry", () => {
    const store = createStore(sampleConfig());
    store.set((c) => ({ ...c, workload: { ...c.workload, storeTB: 1 } }), {
      recordHistory: false,
    });
    expect(store.canUndo()).toBe(false);
  });

  it("subscribe fires on set/undo/redo/replace", () => {
    const store = createStore(sampleConfig());
    let n = 0;
    store.subscribe(() => n++);
    store.set((c) => c);
    store.undo();
    store.redo();
    store.replace(sampleConfig());
    expect(n).toBe(4);
  });

  it("mutator must return an object", () => {
    const store = createStore(sampleConfig());
    expect(() => store.set(() => null)).toThrow();
  });
});

describe("canvas tree operations", () => {
  it("walkPools visits the root and nested pools", () => {
    const cfg = sampleConfig();
    const paths = [];
    walkPools(cfg.tree, "tree", (_n, p) => paths.push(p));
    expect(paths).toEqual(["tree"]);
  });

  it("connectDiskToPool appends a kind-ref member", () => {
    const cfg = connectDiskToPool(sampleConfig(), "hdd8", "tree");
    expect(cfg.tree.members).toHaveLength(2);
    expect(cfg.tree.members[1]).toEqual({
      node: "kind",
      kind: "hdd8",
      count: 1,
    });
  });

  it("setRoot promotes a pool to root", () => {
    // build a two-level tree: root concat containing an inner strip pool
    const cfg = sampleConfig();
    cfg.tree = {
      node: "pool",
      strategy: "concat",
      lambdaCC: 0,
      members: [sampleConfig().tree],
    };
    const next = setRoot(cfg, "tree.members[0]");
    expect(next.tree.strategy).toBe("strip");
    expect(next.tree.members).toHaveLength(1);
  });

  it("removeNode removes a member by path", () => {
    const cfg = connectDiskToPool(sampleConfig(), "hdd8", "tree");
    const next = removeNode(cfg, "tree.members[0]");
    expect(next.tree.members).toHaveLength(1);
    expect(next.tree.members[0].kind).toBe("hdd8");
  });

  it("addPool appends an empty concat pool member", () => {
    const cfg = addPool(sampleConfig(), {
      strategy: "concat",
      parentPath: "tree",
    });
    expect(cfg.tree.members).toHaveLength(2);
    expect(cfg.tree.members[1]).toEqual({
      node: "pool",
      strategy: "concat",
      lambdaCC: 0,
      members: [],
    });
  });

  it("resolvePath and setPath round-trip", () => {
    const cfg = sampleConfig();
    expect(resolvePath(cfg, "tree").strategy).toBe("strip");
    const next = setPath(cfg, "tree.lambdaCC", 5e-7);
    expect(resolvePath(next, "tree").lambdaCC).toBe(5e-7);
    expect(resolvePath(cfg, "tree").lambdaCC).toBe(0); // immutability
  });

  it("poolLayoutTree exposes the pool hierarchy with true slot indices", () => {
    const vm = poolLayoutTree(sampleConfig());
    expect(vm.id).toBe("tree");
    expect(vm.strategy).toBe("strip");
    expect(vm.children).toHaveLength(0); // the only member is a disk model, not a pool
  });
});

describe("charts", () => {
  it("linePath builds an SVG path", () => {
    expect(
      linePath([
        [0, 10],
        [5, 20],
        [10, 15],
      ]),
    ).toBe("M 0 10 L 5 20 L 10 15");
    expect(linePath([])).toBe("");
  });

  it("linearScale maps domain to range", () => {
    const f = linearScale([0, 10], [0, 100]);
    expect(f(0)).toBe(0);
    expect(f(5)).toBe(50);
    expect(f(10)).toBe(100);
  });

  it("logScale is monotone and boundary-anchored", () => {
    const f = logScale([1, 100], [0, 2]);
    expect(f(1)).toBeCloseTo(0);
    expect(f(100)).toBeCloseTo(2);
    expect(f(10)).toBeCloseTo(1);
  });

  it("logTicks spans the decade range", () => {
    expect(logTicks([1, 1000])).toEqual([1, 10, 100, 1000]);
    expect(logTicks([0.01, 100])).toEqual([0.01, 0.1, 1, 10, 100]);
  });
});

describe("layout", () => {
  it("places a leaf at origin", () => {
    const pos = tidyLayoutSized({ id: "a", children: [] });
    expect(pos.get("a")).toEqual({ x: 0, y: 0 });
  });

  it("centers parent over two children", () => {
    const pos = tidyLayoutSized({
      id: "root",
      children: [
        { id: "l", children: [] },
        { id: "r", children: [] },
      ],
    });
    const l = pos.get("l");
    const r = pos.get("r");
    expect(l.x).toBeLessThan(r.x);
    expect(pos.get("root").x).toBeCloseTo((l.x + r.x) / 2);
    expect(pos.get("root").y).toBeLessThan(l.y);
  });

  it("no two nodes share a position (distinct ids)", () => {
    const pos = tidyLayoutSized({
      id: "a",
      children: [
        {
          id: "b",
          children: [
            { id: "d", children: [] },
            { id: "e", children: [] },
          ],
        },
        { id: "c", children: [] },
      ],
    });
    const seen = new Set();
    for (const { x, y } of pos.values()) seen.add(`${x},${y}`);
    expect(seen.size).toBe(pos.size);
  });
});

describe("persistence helpers", () => {
  it("downloadConfig is available (DOM API stubbed in node)", () => {
    expect(typeof downloadConfig).toBe("function");
    expect(typeof readConfigFile).toBe("function");
  });
});

// ---------------------------------------------------------------------------------------------
// ticket 14: canvas UX — free positions, viewport math, drag legality, promotion
// ---------------------------------------------------------------------------------------------

import {
  canReparent,
  setPath,
  moveMember,
  removeNode,
  removeKind,
  reorderMember,
  setRoot,
  setRootPlan,
  connectDiskToPool,
  sparkPath,
  addPool,
} from "../src/ui/canvas.js";
import {
  PAD,
  NODE_W,
  canvasPositions,
  rekeyPositions,
  zoomAt,
  clampZoom,
  fitView,
  screenToWorld,
  worldToScreen,
  poolLayoutTree,
  boundsOf,
} from "../src/ui/positions.js";
import { tidyLayoutSized } from "../src/ui/layout.js";
import { fuzzyMatch } from "../src/ui/commands.js";

const nestedConfig = () => ({
  schemaVersion: 1,
  kinds: {
    hdd8: {
      capacityTB: 8,
      lambdaBase: 2.8e-6,
      lambdaRead: 0,
      lambdaWrite: 0,
      ure: 0,
      readBW: 190e6,
      writeBW: 170e6,
      count: 20,
      spares: 1,
    },
    ssd1: {
      capacityTB: 1,
      lambdaBase: 1e-6,
      lambdaRead: 0,
      lambdaWrite: 0,
      ure: 0,
      readBW: 500e6,
      writeBW: 400e6,
      count: 4,
      spares: 0,
    },
  },
  tree: {
    node: "pool",
    strategy: "concat",
    lambdaCC: 0,
    members: [
      {
        node: "pool",
        strategy: "strip",
        d: 3,
        m: 1,
        lambdaCC: 0,
        members: [{ node: "kind", kind: "hdd8", count: 4 }],
      },
      {
        node: "pool",
        strategy: "strip",
        d: 1,
        m: 1,
        lambdaCC: 0,
        members: [{ node: "kind", kind: "ssd1", count: 2 }],
      },
    ],
  },
  global: { tOpH: 12, tSwapH: 0.2, tProcH: 48, rebuildBw: 150e6, contention: true },
  workload: { storeTB: 10, readBps: 0, writeBps: 0, avgFileMB: 8, horizonY: 5 },
});

describe("positions: re-keying across structural edits", () => {
  it("keeps an untouched sibling's position when the first member is deleted", () => {
    const before = nestedConfig();
    const pos = {
      tree: { x: 0, y: 0 },
      "tree.members[0]": { x: 10, y: 100 },
      "tree.members[1]": { x: 300, y: 100 },
    };
    const after = removeNode(before, "tree.members[0]");
    const re = rekeyPositions(before, after, pos);
    // the surviving pool was members[1] and now IS members[0]: its position must follow it,
    // never the deleted node's slot
    expect(re["tree.members[0]"]).toEqual({ x: 300, y: 100 });
    expect(re["tree.members[1]"]).toBeUndefined();
    expect(re.tree).toEqual({ x: 0, y: 0 });
  });

  it("carries a re-parented subtree's position with it", () => {
    const before = nestedConfig();
    const pos = { "tree.members[1]": { x: 300, y: 100 } };
    const after = moveMember(before, "tree.members[1]", "tree.members[0]");
    const re = rekeyPositions(before, after, pos);
    expect(re["tree.members[0].members[1]"]).toEqual({ x: 300, y: 100 });
  });

  it("keeps the position of a node whose fields changed in place", () => {
    const before = nestedConfig();
    const pos = { "tree.members[0]": { x: 42, y: 7 } };
    const after = {
      ...before,
      tree: {
        ...before.tree,
        members: [{ ...before.tree.members[0], d: 4 }, before.tree.members[1]],
      },
    };
    expect(rekeyPositions(before, after, pos)["tree.members[0]"]).toEqual({ x: 42, y: 7 });
  });

  it("drops positions for nodes that no longer exist", () => {
    const before = nestedConfig();
    const pos = { "tree.members[9]": { x: 1, y: 1 }, tree: { x: 2, y: 2 } };
    const re = rekeyPositions(before, nestedConfig(), pos);
    expect(Object.keys(re)).toEqual(["tree"]);
  });
});

describe("positions: layout and viewport", () => {
  it("lays out pools only — disk kinds are not canvas nodes", () => {
    const t = poolLayoutTree(nestedConfig());
    expect(t.id).toBe("tree");
    expect(t.children.map((c) => c.id)).toEqual(["tree.members[0]", "tree.members[1]"]);
  });

  it("hides the subtree of a collapsed pool", () => {
    const t = poolLayoutTree(nestedConfig(), { "tree.members[0]": true });
    expect(t.children[0].children).toEqual([]);
  });

  it("canvasPositions offsets by PAD and honours stored drags", () => {
    const p = canvasPositions(nestedConfig(), {
      pos: { "tree.members[1]": { x: 500, y: 20 } },
    });
    expect(p.get("tree.members[1]")).toEqual({ x: 500 + PAD, y: 20 + PAD });
    expect(p.get("tree").x).toBeGreaterThanOrEqual(PAD);
  });

  it("tidyLayoutSized stacks levels by the tallest card and never overlaps siblings", () => {
    const pos = tidyLayoutSized(
      {
        id: "r",
        children: [
          { id: "a", children: [] },
          { id: "b", children: [] },
        ],
      },
      { heightOf: (n) => (n.id === "r" ? 240 : 120), widthOf: () => 200, gapX: 40, gapY: 50 },
    );
    expect(pos.get("a").y).toBe(pos.get("b").y);
    expect(pos.get("r").y).toBe(0);
    expect(pos.get("a").y).toBe(290);
    expect(pos.get("b").x - pos.get("a").x).toBe(240);
  });

  it("zoomAt keeps the world point under the cursor fixed", () => {
    const before = { x: 10, y: 20, zoom: 1 };
    const world = screenToWorld(before, 300, 150);
    const after = zoomAt(before, 2, 300, 150);
    expect(after.zoom).toBe(2);
    const screen = worldToScreen(after, world.x, world.y);
    expect(screen.x).toBeCloseTo(300);
    expect(screen.y).toBeCloseTo(150);
  });

  it("clamps zoom to the documented range", () => {
    expect(clampZoom(100)).toBe(2);
    expect(clampZoom(0.0001)).toBe(0.25);
  });

  it("fitView centres the content in the viewport", () => {
    const b = { x0: 0, y0: 0, x1: NODE_W, y1: 100 };
    const v = fitView(b, { width: 800, height: 600 });
    expect(v.zoom).toBeGreaterThan(0);
    expect(v.zoom).toBeLessThanOrEqual(2);
    const c = worldToScreen(v, NODE_W / 2, 50);
    expect(c.x).toBeCloseTo(400);
    expect(c.y).toBeCloseTo(300);
  });

  it("boundsOf covers every placed node", () => {
    const b = boundsOf(
      new Map([
        ["a", { x: 0, y: 0 }],
        ["b", { x: 100, y: 40 }],
      ]),
      () => ({ w: 50, h: 30 }),
    );
    expect(b).toEqual({ x0: 0, y0: 0, x1: 150, y1: 70 });
  });

  it("sparkPath is empty for a single sample and monotone in x", () => {
    expect(sparkPath([1], 100, 20)).toBe("");
    const d = sparkPath([1, 2, 3], 100, 20);
    expect(d.startsWith("M")).toBe(true);
    expect(d.split(" L ")).toHaveLength(3);
  });
});

describe("canvas: drag legality and structure ops", () => {
  it("refuses to drop the root into itself and explains why", () => {
    const r = canReparent(nestedConfig(), "tree", "tree.members[0]");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/root is the top level/);
  });

  it("refuses a cycle and explains why", () => {
    const r = canReparent(nestedConfig(), "tree.members[0]", "tree.members[0]");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot contain itself/);
    const r2 = canReparent(
      nestedConfig(),
      "tree.members[0]",
      "tree.members[0].members[0]",
    );
    expect(r2.ok).toBe(false);
  });

  it("accepts moving a member under another pool", () => {
    const r = canReparent(nestedConfig(), "tree.members[1]", "tree.members[0]");
    expect(r.ok).toBe(true);
    const next = moveMember(nestedConfig(), "tree.members[1]", "tree.members[0]");
    expect(next.tree.members).toHaveLength(1);
    expect(next.tree.members[0].members).toHaveLength(2);
  });

  it("inserts at a slot and renumbers correctly", () => {
    const before = addPool(nestedConfig(), { strategy: "concat", parentPath: "tree" });
    const next = moveMember(before, "tree.members[2]", "tree", 0);
    expect(next.tree.members[0].strategy).toBe("concat");
    expect(next.tree.members).toHaveLength(3);
  });

  it("reorderMember swaps neighbours and is a no-op at the edges", () => {
    const before = nestedConfig();
    const next = reorderMember(before, "tree", 0, 1);
    expect(next.tree.members[0].d).toBe(1);
    expect(reorderMember(before, "tree", 0, -1)).toBe(before);
  });

  it("removeNode refuses the root", () => {
    expect(() => removeNode(nestedConfig(), "tree")).toThrow(/root cannot be deleted/);
  });

  it("setRootPlan reports swap vs wrap", () => {
    const single = { ...nestedConfig(), tree: { ...nestedConfig().tree, members: [nestedConfig().tree.members[0]] } };
    expect(setRootPlan(single, "tree.members[0]").kind).toBe("swap");
    expect(setRootPlan(nestedConfig(), "tree.members[0]")).toEqual({ kind: "wrap", others: 1 });
  });

  it("setRoot swap promotes without wrapping", () => {
    const cfg = nestedConfig();
    cfg.tree = { ...cfg.tree, members: [cfg.tree.members[0]] };
    const next = setRoot(cfg, "tree.members[0]");
    expect(next.tree.strategy).toBe("strip");
    expect(next.tree.members).toHaveLength(1);
  });

  it("setRoot refuses to strand nodes unless wrap is requested, then loses nothing", () => {
    const cfg = nestedConfig();
    expect(() => setRoot(cfg, "tree.members[0]")).toThrow(/strand/);
    const next = setRoot(cfg, "tree.members[0]", { wrap: true });
    expect(next.tree.strategy).toBe("strip");
    // the rest of the old tree is nested under the promoted pool: 1 disk + the old root
    expect(next.tree.members).toHaveLength(2);
    expect(next.tree.members[1].strategy).toBe("concat");
    expect(next.tree.members[1].members).toHaveLength(1);
  });

  it("removeKind refuses while referenced, then succeeds when free", () => {
    const cfg = nestedConfig();
    expect(() => removeKind(cfg, "hdd8")).toThrow(/still referenced/);
    const cut = removeNode(cfg, "tree.members[0]");
    expect(removeKind(cut, "hdd8").kinds.hdd8).toBeUndefined();
  });

  it("removeKind keeps the last disk model", () => {
    const cfg = nestedConfig();
    const only = { ...cfg, kinds: { ssd1: cfg.kinds.ssd1 } };
    expect(() => removeKind(only, "ssd1")).toThrow(/at least one disk model/);
  });

  it("connectDiskToPool appends a chip member", () => {
    const next = connectDiskToPool(nestedConfig(), "ssd1", "tree.members[0]");
    expect(next.tree.members[0].members).toHaveLength(2);
    expect(next.tree.members[0].members[1]).toEqual({
      node: "kind",
      kind: "ssd1",
      count: 1,
    });
  });
});

describe("command palette matching", () => {
  it("matches on subsequences and rejects non-matches", () => {
    expect(fuzzyMatch("Tidy canvas", "tdy")).toBe(true);
    expect(fuzzyMatch("Set as top-level", "")).toBe(true);
    expect(fuzzyMatch("Tidy canvas", "zzz")).toBe(false);
  });
});

describe("canvas: re-parent robustness (regression)", () => {
  it("moves into a LATER sibling without losing the destination", () => {
    const cfg = nestedConfig();
    const next = moveMember(cfg, "tree.members[0]", "tree.members[1]");
    expect(next.tree.members).toHaveLength(1);
    expect(next.tree.members[0].members).toHaveLength(2);
    expect(next.tree.members[0].members[1].d).toBe(3);
  });

  it("moves into a pool nested inside a later sibling", () => {
    const cfg = nestedConfig();
    const inner = {
      node: "pool",
      strategy: "concat",
      lambdaCC: 0,
      members: [{ node: "pool", strategy: "strip", d: 1, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "ssd1", count: 2 }] }],
    };
    cfg.tree.members[1] = { ...cfg.tree.members[1], members: [inner] };
    const next = moveMember(cfg, "tree.members[0]", "tree.members[1].members[0]", 0);
    expect(next.tree.members).toHaveLength(1);
    expect(next.tree.members[0].members[0].members[0].d).toBe(3);
  });

  it("moves an earlier sibling into an ancestor at slot 0", () => {
    const cfg = nestedConfig();
    const deep = {
      ...cfg,
      tree: {
        ...cfg.tree,
        members: [
          {
            node: "pool",
            strategy: "concat",
            lambdaCC: 0,
            members: [
              { node: "pool", strategy: "strip", d: 3, m: 1, lambdaCC: 0, members: [{ node: "kind", kind: "hdd8", count: 4 }] },
            ],
          },
          cfg.tree.members[1],
        ],
      },
    };
    const next = moveMember(deep, "tree.members[0].members[0]", "tree", 0);
    expect(next.tree.members).toHaveLength(3);
    expect(next.tree.members[0].d).toBe(3);
    expect(next.tree.members[1].members).toHaveLength(0);
  });

  it("moves within the same pool to a later slot", () => {
    const cfg = nestedConfig();
    const next = moveMember(cfg, "tree.members[0]", "tree", 1);
    expect(next.tree.members[0].d).toBe(1); // the ssd strip is now first
    expect(next.tree.members[1].d).toBe(3);
  });

  it("slot 0 of the same pool puts the node first", () => {
    const cfg = nestedConfig();
    const next = moveMember(cfg, "tree.members[1]", "tree", 0);
    expect(next.tree.members[0].d).toBe(1);
    expect(next.tree.members[1].d).toBe(3);
  });

  it("appends when slot is null and clamps out-of-range slots", () => {
    const cfg = nestedConfig();
    expect(moveMember(cfg, "tree.members[0]", "tree", 99).tree.members[1].d).toBe(3);
    expect(moveMember(cfg, "tree.members[0]", "tree", null).tree.members[1].d).toBe(3);
  });

  it("does not mutate the input config", () => {
    const cfg = nestedConfig();
    moveMember(cfg, "tree.members[0]", "tree.members[1]");
    expect(cfg.tree.members).toHaveLength(2);
  });
});

describe("positions: slot indices must be true member indices (regression)", () => {
  it("nested pool keeps its real path when a kind reference occupies slot 0", () => {
    const cfg = nestedConfig();
    cfg.tree.members[0] = {
      node: "pool",
      strategy: "concat",
      lambdaCC: 0,
      members: [{ node: "kind", kind: "hdd8", count: 2 }, cfg.tree.members[0]],
    };
    const t = poolLayoutTree(cfg);
    expect(t.children[0].id).toBe("tree.members[0]");
    expect(t.children[0].children[0].id).toBe("tree.members[0].members[1]");
    const p = canvasPositions(cfg);
    expect(p.has("tree.members[0].members[1]")).toBe(true);
  });
});

describe("canvas: root-level edits and promotion plan (regressions)", () => {
  it("setPath accepts the root itself as the target", () => {
    const cfg = sampleConfig();
    const next = setPath(cfg, "tree", { ...cfg.tree, lambdaCC: 0.003 });
    expect(next.tree.lambdaCC).toBe(0.003);
    expect(next.tree.members).toHaveLength(1);
    expect(cfg.tree.lambdaCC).toBe(0);
  });

  it("setPath still reaches nested nodes and disk models", () => {
    const cfg = nestedConfig();
    expect(setPath(cfg, "tree.members[0]", { ...cfg.tree.members[0], d: 9 }).tree.members[0].d).toBe(9);
    expect(setPath(cfg, "kinds.hdd8", { ...cfg.kinds.hdd8, count: 3 }).kinds.hdd8.count).toBe(3);
  });

  it("setRootPlan counts the nodes a wrap would absorb, never the promoted pool itself", () => {
    const cfg = nestedConfig();
    expect(setRootPlan(cfg, "tree.members[0]")).toEqual({ kind: "wrap", others: 1 });
    const deep = nestedConfig();
    deep.tree.members[0] = {
      node: "pool",
      strategy: "concat",
      lambdaCC: 0,
      members: [deep.tree.members[1]],
    };
    // promoting the nested pool leaves the whole old root to be nested: 2 top-level members
    expect(setRootPlan(deep, "tree.members[0].members[0]").kind).toBe("wrap");
  });

  it("rekeyPositions follows an explicit hint for a node the operation rebuilt", () => {
    const before = nestedConfig();
    const pos = { "tree.members[0]": { x: 111, y: 222 } };
    const after = setRoot(before, "tree.members[0]", { wrap: true });
    const re = rekeyPositions(before, after, pos, { "tree.members[0]": "tree" });
    expect(re.tree).toEqual({ x: 111, y: 222 });
    // and the promoted node's old path must not be handed to the newly nested child
    expect(re["tree.members[0]"]).toBeUndefined();
  });
});
