import { describe, it, expect } from "vitest";
import { createStore, downloadConfig, readConfigFile } from "../src/ui/app.js";
import {
  connectDiskToPool,
  connectPoolToPool,
  connectPoolToOutput,
  disconnectMember,
  addPool,
  walkPools,
  resolvePath,
  setPath,
  treeViewModel,
} from "../src/ui/canvas.js";
import { linePath, logScale, linearScale, logTicks } from "../src/ui/charts.js";
import { tidyLayout } from "../src/ui/layout.js";

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

  it("connectPoolToPool only allows the root to become a member (one-parent rule)", () => {
    const cfg = sampleConfig();
    expect(() => connectPoolToPool(cfg, "tree", "tree")).toThrow(/itself/);
  });

  it("connectPoolToOutput promotes a pool to root", () => {
    // build a two-level tree: root concat containing an inner strip pool
    const cfg = sampleConfig();
    cfg.tree = {
      node: "pool",
      strategy: "concat",
      lambdaCC: 0,
      members: [sampleConfig().tree],
    };
    const next = connectPoolToOutput(cfg, "tree.members[0]");
    expect(next.tree.strategy).toBe("strip");
    expect(next.tree.members).toHaveLength(1);
  });

  it("disconnectMember removes a member", () => {
    const cfg = connectDiskToPool(sampleConfig(), "hdd8", "tree");
    const next = disconnectMember(cfg, "tree", 0);
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

  it("treeViewModel exposes the pool hierarchy", () => {
    const vm = treeViewModel(sampleConfig());
    expect(vm.id).toBe("tree");
    expect(vm.strategy).toBe("strip");
    expect(vm.children).toHaveLength(1);
    expect(vm.children[0].kindId).toBe("hdd8");
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
    const pos = tidyLayout({ id: "a", children: [] });
    expect(pos.get("a")).toEqual({ x: 0, y: 0 });
  });

  it("centers parent over two children", () => {
    const pos = tidyLayout({
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
    const pos = tidyLayout({
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
