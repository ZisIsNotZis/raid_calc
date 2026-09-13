// Tidy-tree layout for the node canvas (raid-calc.md §3 tree constraint).
// Pure function over a node tree { id, children: [] } -> Map id -> { x, y } in canvas units.
// Top-down: leaves advance a horizontal cursor by their own width, parents centre over their
// children's roots, and each level's y is the previous level's TALLEST card + gap — cards differ
// in height (a root with a result ribbon is taller than a collapsed pool). `heightOf` may be
// called before the DOM exists: pass estimates, then re-run after measuring.
export function tidyLayoutSized(
  root,
  { heightOf = () => 120, widthOf = () => 210, gapX = 44, gapY = 48 } = {},
) {
  const levelHeight = [];
  const measure = (node, depth) => {
    levelHeight[depth] = Math.max(levelHeight[depth] || 0, heightOf(node));
    for (const c of node.children || []) measure(c, depth + 1);
  };
  measure(root, 0);
  const yOf = [0];
  for (let i = 1; i < levelHeight.length; i++)
    yOf[i] = yOf[i - 1] + levelHeight[i - 1] + gapY;

  const pos = new Map();
  let cursor = 0;
  // span = { left, right, cx } of the placed subtree
  const place = (node, depth) => {
    const w = widthOf(node);
    const kids = node.children || [];
    const self = { x: 0, y: yOf[depth] };
    if (kids.length === 0) {
      self.x = cursor;
      cursor += w + gapX;
      pos.set(node.id, self);
      return { left: self.x, right: self.x + w, cx: self.x + w / 2 };
    }
    const spans = kids.map((k) => place(k, depth + 1));
    const cx = (spans[0].cx + spans[spans.length - 1].cx) / 2;
    self.x = cx - w / 2;
    pos.set(node.id, self);
    return {
      left: Math.min(spans[0].left, self.x),
      right: Math.max(spans[spans.length - 1].right, self.x + w),
      cx,
    };
  };
  place(root, 0);
  let minX = Infinity;
  for (const p of pos.values()) minX = Math.min(minX, p.x);
  for (const p of pos.values()) p.x = Math.round(p.x - minX);
  for (const p of pos.values()) p.y = Math.round(p.y);
  return pos;
}
