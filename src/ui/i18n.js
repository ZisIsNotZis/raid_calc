// UI language + theme. The English string is the key, so a missing translation falls back to
// readable English instead of a raw identifier.
//
// Preference order on boot: saved preference → config.ui → browser/OS hint. The saved preference
// lives in localStorage because "which language / which theme" is an environment choice, not project
// data: it must survive a refresh that deliberately discards the config.

const PREF_KEY = "raid_calc:prefs";

export const LANGS = ["en", "zh"];
export const THEMES = ["dark", "light"];

const ZH = {
  // header / shell
  "◉ raid_calc": "◉ raid_calc",
  Run: "运行",
  "Auto-optimize": "自动优化",
  Import: "导入",
  Export: "导出",
  "Reset example": "重置示例",
  Results: "结果",
  Undo: "撤销",
  Redo: "重做",
  "workload + global timings (selects the Scenario panel)":
    "负载与全局参数（选择 Scenario 面板）",
  "keyboard & gestures": "键盘与手势",
  Cancel: "取消",
  Close: "关闭",
  Apply: "应用",
  Confirm: "确认",
  Delete: "删除",
  // sidebar
  Build: "构建",
  Pool: "存储池",
  "Disk model": "磁盘型号",
  "Disk library (drag onto a pool)": "磁盘库（拖到存储池上）",
  Inventory: "清单",
  "disks": "磁盘",
  referenced: "已引用",
  "hot spares": "热备",
  free: "空闲",
  "Ctrl+K commands · ? shortcuts": "Ctrl+K 命令 · ? 快捷键",
  "Open charts": "打开图表",
  "press Run (R)": "按 Run (R) 运行",
  // canvas hud + cards
  Tidy: "整理",
  Fit: "适应",
  "space+drag pan · wheel zoom · ctrl+K commands":
    "空格+拖动平移 · 滚轮缩放 · ctrl+K 命令",
  "click for the full results drawer": "点击打开完整结果面板",
  "no run yet — press R": "尚未运行 — 按 R",
  "config changed since this run — press R": "配置已修改，此结果来自上次运行 — 按 R 重算",
  strategy: "策略",
  members: "成员",
  hidden: "已折叠",
  "member input — drop a pool here": "成员输入 — 把存储池拖到这里",
  "member input": "成员输入",
  "drag to re-parent · drop on empty canvas to cut the link":
    "拖动以改变父级 · 放在空白处取消",
  "remove member": "移除成员",
  "add a member (or drop a disk model from the library here)":
    "添加成员（或从磁盘库拖一个型号到这里）",
  "expand": "展开",
  "collapse": "折叠",
  "preview…": "预览…",
  "checking…": "计算中…",
  "preview unavailable": "无法预览",
  "preview unavailable: {why}": "无法预览：{why}",
  // drag chips + hints
  "drop on a pool to re-link · release on empty space to cancel":
    "放到存储池上以重新连接 · 放在空白处取消",
  "drop on a pool to make it a member": "放到存储池上使其成为成员",
  "release here to create a new pool": "松手在此新建存储池",
  // palette
  "Type a command…": "输入命令…",
  "no matching command": "没有匹配的命令",
  "Add pool member to selection": "把存储池加入所选对象",
  "Add strip pool member": "加入 strip 存储池成员",
  "Add disk model": "新建磁盘型号",
  "Add member pool": "新建成员存储池",
  "Run evaluation": "运行计算",
  "Tidy canvas": "整理画布",
  "Fit view": "适应视图",
  "Reset zoom": "重置缩放",
  "Toggle results drawer": "开关结果面板",
  "Scenario settings": "Scenario 设置",
  "Set selection as top-level": "将所选设为顶层",
  "Delete selection": "删除所选",
  "Wrap selection in a new pool": "用新存储池包裹所选",
  "Export config": "导出配置",
  Shortcuts: "快捷键",
  // props
  "Nothing selected": "未选中任何对象",
  "Root pool (top-level)": "根存储池（顶层）",
  "Pool · {path}": "存储池 · {path}",
  "Disk model · {id}": "磁盘型号 · {id}",
  Scenario: "Scenario",
  "workload + global timings": "负载与全局参数",
  "result of the whole config": "整个配置的结果",
  "referenced {n}× on the canvas": "在画布上被引用 {n} 次",
  Strategy: "策略",
  "D data members": "D 数据成员",
  "M parity": "M 校验",
  "N data chunks": "N 数据块",
  "λ common-cause (/h)": "λ 共因故障 (/h)",
  "Members (order matters)": "成员（顺序有意义）",
  Actions: "操作",
  "⬆ Set as top-level": "⬆ 设为顶层",
  "🗑 Delete pool": "🗑 删除存储池",
  "🗑 Delete disk model": "🗑 删除磁盘型号",
  "+ add pool member": "+ 添加存储池成员",
  Workload: "负载",
  "Store ≥ (TB)": "存储需求 ≥ (TB)",
  "Avg read (MB/s)": "平均读 (MB/s)",
  "Avg write (MB/s)": "平均写 (MB/s)",
  "Avg file size (MB)": "平均文件大小 (MB)",
  "Horizon (years)": "时间跨度（年）",
  Global: "全局",
  "T_op human (h)": "T_op 人工 (h)",
  "T_swap spare (h)": "T_swap 更换备件 (h)",
  "T_proc buy (h)": "T_proc 采购 (h)",
  "Dedicated rebuild bw (MB/s)": "专用重建带宽 (MB/s)",
  "Bandwidth mode": "带宽模式",
  "contended (shared with workload)": "共享（与业务争用）",
  "dedicated rebuildBw": "专用 rebuildBw",
  "Capacity (TB)": "容量 (TB)",
  "λ base (/h)": "λ 基础 (/h)",
  "λ read (/B)": "λ 读 (/B)",
  "λ write (/B)": "λ 写 (/B)",
  "URE (/B)": "URE (/B)",
  "Read bandwidth (MB/s)": "读带宽 (MB/s)",
  "Write bandwidth (MB/s)": "写带宽 (MB/s)",
  "Inventory count": "库存数量",
  "Hot spares (auto)": "热备（自动）",
  "Canvas gestures": "画布手势",
  "Click a pool card to edit it. Drag a card to move or re-parent it; drag its top port to ":
    "点击存储池卡片进行编辑。拖动卡片可移动或改变父级；拖动顶部端口",
  "Nothing selected hint": "",
  "invalid value for {label}": "{label} 的值无效",
  "{label} must be >= {min}": "{label} 必须 >= {min}",
  "edit rejected — check the full config": "修改被拒绝 — 请检查完整配置",
  // cards / kv
  "E[lost]": "E[lost]",
  "P(any loss)": "P(任意丢失)",
  usable: "可用",
  slowdown: "降速",
  "P(loss)": "P(丢失)",
  "E[lost] @T": "E[lost] @T",
  // dialogs / toasts / menus
  "Keep the rest of the tree?": "保留其余部分？",
  "Promote & keep": "提升并保留",
  "the root cannot be deleted — promote another pool first":
    "根节点不能删除 — 请先把另一个存储池设为顶层",
  "select a pool that already sits inside another pool":
    "请选择一个已经位于其他存储池内部的存储池",
  "select a pool first": "请先选择一个存储池",
  "config JSON copied": "配置 JSON 已复制",
  "that drop is not allowed": "不允许这样放置",
  "the link was kept — click its wire (or hover ✕) to cut it":
    "连接已保留 — 点击连线（或悬停 ✕）可断开",

  "promoting this pool would strand {n} other node(s) — confirm to keep them under it":
    "提升后会有 {n} 个其他节点无处安放 — 确认将它们放在新根之下",
  "Promoting this pool would leave {n} other node(s) outside the new root. ":
    "提升此存储池会让 {n} 个其他节点落到新根之外。",
  "Keep them by nesting the old root under the promoted pool (nothing is discarded), or cancel.":
    "把它们嵌到提升后的存储池之下即可全部保留，或取消。",
  "Copy config JSON": "复制配置 JSON",
  "Delete pool": "删除存储池",
  "Set as top-level": "设为顶层",
  "Wrap in a new pool": "用新存储池包裹",
  "Delete disk model": "删除磁盘型号",
  Design: "方案",
  Why: "原因",
  // drawer
  "Run the evaluation to see curves here.": "运行计算后在此查看曲线。",
  "Pin current": "固定当前",
  "Clear pins": "清除固定",
  "E[lost](t)": "E[丢失](t)",
  "P(any loss)(t)": "P(任意丢失)(t)",
  // preview
  "Standalone preview shown on the card.": "卡片下方的独立预览。",
  "preview unavailable: unsupported subtree": "无法预览：子树不受支持",
  // round 2 additions
  "drag onto a pool (or empty canvas) to create one there":
    "拖到存储池上（或空白处）以在那里新建",
  root: "根节点",
  "no free {kind} disks left — raise its inventory count first":
    "没有空闲的 {kind} 磁盘了 — 请先增加它的库存数量",
  "no free disks left — raise a disk model's inventory count first":
    "没有空闲磁盘了 — 请先增加某个磁盘型号的库存数量",
  pool: "存储池",
  "λcc /h": "λcc /h",
  "TOP-LEVEL": "顶层",
  "{n} member(s)": "{n} 个成员",
  "re-link · drop on empty canvas to cancel": "重新连接 · 放到空白处取消",
  "drag to re-parent · drop on empty canvas to cancel": "拖动以改变父级 · 放在空白处取消",
  "language / 语言": "语言 / language",
  "theme": "主题",
  "keep this curve as a comparison overlay": "把这条曲线固定为对比叠加",
  "Ctrl+K opens the command palette. ? lists every shortcut.":
    "Ctrl+K 打开命令面板，? 查看全部快捷键。",
  "Keyboard & gestures": "键盘与手势",
  "run the evaluation": "运行计算",
  "tidy the canvas (drop manual positions)": "整理画布（清除手动位置）",
  "fit the view to the tree": "让视图适应整棵树",
  "reset zoom to 100%": "缩放重置为 100%",
  "toggle the results drawer": "开关结果面板",
  "no run to pin yet": "还没有可固定的结果",
  contended: "共享带宽",
  dedicated: "专用带宽",
  "Expand": "展开",
  "Collapse": "折叠",
  "concat (JBOD)": "concat（JBOD 串联）",
  "strip (D,M)": "strip（D,M 条带）",
  "split (N,M)": "split（N,M 分片）",
  "strip-split (N,M)": "strip-split（N,M 条带分片）",
  "Click a pool card to edit it. Drag a card to move or re-parent it; drag its top port to re-link it. Drag a disk model from the library onto a pool to add a member.":
    "点击存储池卡片即可编辑。拖动卡片可移动或改变父级；拖动顶部端口可重新连接。把磁盘库中的型号拖到存储池上即可添加成员。",
  "move it · drop on a pool to re-parent": "移动 · 放到存储池上改变父级",
    "select it (hover shows ✕)": "选中（悬停显示 ✕）",
  "edit it in place": "就地编辑",
  "zoom · pan · pan": "缩放 · 平移 · 平移",
    "every pool here needs an exact number of members — add it to a concat pool instead":
    "这里的每个存储池都要求固定的成员数量 — 请改为加入一个 concat 存储池",
  "no pool here can take another member — nested it beside the nearest one":
    "这里没有能再容纳成员的存储池 — 已放在最近的成员旁边",
  "undo / redo": "撤销 / 重做",
  "delete the selected pool, disk model, or selected wire":
    "删除所选的存储池、磁盘型号或连线",
  "cancel a drag · close a dialog · deselect": "取消拖动 · 关闭对话框 · 取消选择",
            "zoom (same as wheel)": "缩放（同滚轮）",
  "Optimizer module unavailable.": "优化模块不可用。",
  "Optimizer module exposes no optimize().": "优化模块未导出 optimize()。",
  "optimize() returned an unexpected shape.": "optimize() 返回了意外的结构。",
};

const DICTS = { en: {}, zh: ZH };

export function makeT(lang) {
  const dict = DICTS[lang] || {};
  return (text, vars) => {
    let s = Object.hasOwn(dict, text) ? dict[text] : text;
    if (vars)
      for (const [k, v] of Object.entries(vars))
        s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}

export function detectLang() {
  const nav = (globalThis.navigator && navigator.language) || "en";
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function detectTheme() {
  return globalThis.matchMedia &&
    matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function readPrefs() {
  try {
    const raw = globalThis.localStorage && localStorage.getItem(PREF_KEY);
    if (!raw) return {};
    const p = globalThis.JSON ? JSON.parse(raw) : {};
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

export function writePrefs(prefs) {
  try {
    if (globalThis.localStorage)
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode: preferences simply do not persist */
  }
}

export function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : "dark";
  if (typeof document !== "undefined")
    document.documentElement.dataset.theme = t;
  return t;
}
