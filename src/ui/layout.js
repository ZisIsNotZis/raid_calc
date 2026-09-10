// Tidy-tree layout for the node canvas (raid-calc.md §3 tree constraint).
// Pure functions over an abstract node tree: { id, children: [] }.
// Returns a Map id -> { x, y } in layout units (the caller scales/offsets).
// Top-down tree: children placed left-to-right with a horizontal gap, parent centered over
// its children's roots. Leaves at y=0; each level descends by LEVEL_GAP.

export const NODE_GAP = 60; // horizontal gap between siblings (layout units)
export const LEVEL_GAP = 160; // vertical gap between levels (layout units)

export function tidyLayout(root) {
  // returns { layout: [{id,x,y}], width } for this subtree (root first)
  const place = (node) => {
    if (!node.children || node.children.length === 0) {
      return { layout: [{ id: node.id, x: 0, y: 0 }], width: 1 };
    }
    const childLayouts = node.children.map(place);
    let cursor = 0;
    const xs = [];
    const all = [];
    for (const child of childLayouts) {
      const childMinX = Math.min(...child.layout.map((p) => p.x));
      const shift = cursor - childMinX;
      for (const p of child.layout) p.x += shift;
      xs.push(child.layout[0].x); // child root x
      all.push(...child.layout);
      cursor += child.width + NODE_GAP;
    }
    const parentX = (xs[0] + xs[xs.length - 1]) / 2;
    const parentY = all[0].y - LEVEL_GAP; // children share the same y
    return {
      layout: [{ id: node.id, x: parentX, y: parentY }, ...all],
      width: cursor - NODE_GAP,
    };
  };
  const { layout } = place(root);
  const minX = Math.min(...layout.map((p) => p.x));
  const minY = Math.min(...layout.map((p) => p.y));
  const byId = new Map();
  for (const p of layout) byId.set(p.id, { x: p.x - minX, y: p.y - minY });
  return byId;
}
