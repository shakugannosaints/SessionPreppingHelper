let cy;
let selectedNode = null;
let linkPick = [];
let sidebarWidth = 320;
// in-memory curvature overrides (for auto edges or session-only)
const edgeCpd = new Map();
// cached groups for fast overlay rendering
let cachedGroups = [];
const groupDomCache = new Map();
const groupBadgeCache = new Map();
let groupOverlaySvg = null;
let rafGroups = null;
// 布局尺寸变化后让画布重算尺寸（工具栏换行、拖动侧栏、窗口缩放）
let rafGraphResize = null;
function scheduleGraphResize() {
  if (rafGraphResize) return;
  rafGraphResize = requestAnimationFrame(() => {
    rafGraphResize = null;
    if (!cy) return;
    try { cy.resize(); } catch {}
    try { renderGroups(); } catch {}
  });
}

function applyGraphTheme() {
  if (!cy) return;
  const p = themePalette();
  try {
    cy.style().selector('node').style({ 'border-color': p.nodeBorder }).update();
    cy.style().selector('edge').style({
      'line-color': p.edge,
      'target-arrow-color': p.edge,
      'color': p.edgeText,
      'text-background-color': p.labelBg,
    }).update();
    cy.style().selector('edge.dual').style({ 'source-arrow-color': p.edge }).update();
    cy.nodes().forEach(n => {
      n.style('color', p.nodeText);
      n.style('text-outline-color', p.nodeOutline);
      const base = n.data('baseSelColor');
      if (base) n.data('selColor', isDarkTheme() ? '#38bdf8' : base);
    });
  } catch {}
}

function applyTheme(dark, repaintGraph = true) {
  document.documentElement.classList.toggle('dark', !!dark);
  try { localStorage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light'); } catch {}
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) {
    btn.textContent = dark ? '日间' : '夜间';
    btn.title = dark ? '切换到日间模式' : '切换到夜间模式';
  }
  if (repaintGraph) {
    applyGraphTheme();
    try { renderGroups(); } catch {}
  }
}

function setupThemeToggle() {
  const btn = document.getElementById('btn-theme-toggle');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.onclick = () => applyTheme(!isDarkTheme(), true);
  }
}

// debounced saver for node positions after drag
let dragSaveTimer = null;
let dragSaveIds = new Set();
// 聚焦模式状态：仅当双击同一节点后才进入
let focusNodeId = null;
let lastTapNodeId = null;
let lastTapTime = 0;
const DOUBLE_TAP_MS = 350;
// 图层视图状态：null = 全局浏览；否则为当前图层 id（节点内容共享，位置独立）
let activeLayerId = null;
let cachedLayers = [];
// 图层面板右键菜单 / 拖拽归类状态
let contextTargetId = null;
let dragSourceId = null;
// 编组彩色框显示开关（默认关闭，状态本地保存）
const GROUP_BOXES_STORAGE_KEY = 'sph.showGroupBoxes';
let showGroupBoxes = (() => {
  try { return localStorage.getItem(GROUP_BOXES_STORAGE_KEY) === '1'; } catch { return false; }
})();

// 夜间模式：状态本地保存，画布配色随主题切换
const THEME_STORAGE_KEY = 'sph.theme';
function isDarkTheme() {
  return document.documentElement.classList.contains('dark');
}
function themePalette() {
  return isDarkTheme()
    ? { graphBg: '#0b1220', nodeBorder: '#0f172a', nodeText: '#f8fafc', nodeOutline: '#0b1220', edge: '#64748b', edgeText: '#cbd5e1', labelBg: '#1e293b', groupLabelBg: '#1e293b', groupLabelBorder: '#334155', groupLabelText: '#e2e8f0' }
    : { graphBg: '#ffffff', nodeBorder: '#ffffff', nodeText: '#111111', nodeOutline: '#ffffff', edge: '#CBD5E1', edgeText: '#334155', labelBg: '#ffffff', groupLabelBg: '#ffffff', groupLabelBorder: '#e5e7eb', groupLabelText: '#1f2937' };
}
function exportBg() { return themePalette().graphBg; }

function mapNode(n) {
  const colors = n.style?.colors || ["#9CA3AF"]; 
  const baseSize = n.style?.size || 40;
  const scale = getSizeScale(n.fields);
  const zOrder = getNodeZOrder(n.fields);
  const size = baseSize * scale;
  const gradient = colors.length > 1 ? `linear-gradient(${colors.join(',')})` : colors[0];
  const labelField = (n.fields || []).find(f => f.key === '名称') || (n.fields || []).find(f => f.type === 'text');
  const label = labelField ? String(labelField.value || '') : (n.id || '');
  const baseColor = colors[0] || '#9CA3AF';
  const toHex2 = (v) => ('0' + v.toString(16)).slice(-2);
  const invertHex = (hex) => {
    try {
      let h = String(hex).trim();
      if (!h) return '#3b82f6';
      if (h.startsWith('#')) h = h.slice(1);
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      if (h.length !== 6) return '#3b82f6';
      const r = 255 - parseInt(h.slice(0,2), 16);
      const g = 255 - parseInt(h.slice(2,4), 16);
      const b = 255 - parseInt(h.slice(4,6), 16);
      return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
    } catch { return '#3b82f6'; }
  };
  const baseSelColor = invertHex(baseColor);
  const selColor = isDarkTheme() ? '#38bdf8' : baseSelColor;
  const p = themePalette();
  return {
    data: { id: n.id, label, selColor, baseSelColor },
    position: n.position || undefined,
    style: {
      'background-color': baseColor,
      'width': size,
      'height': size,
      'label': label,
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': Math.max(6, 12 * scale),
      'color': p.nodeText,
      'text-outline-color': p.nodeOutline,
      'text-outline-width': 2,
      'z-index': zOrder,
    }
  };
}

function getSizeScale(fields) {
  const arr = fields || [];
  const f = arr.find(x => String(x.key || '') === '大小倍率');
  if (!f) return 1;
  const v = parseFloat(String(f.value ?? '1'));
  if (!isFinite(v) || isNaN(v)) return 1;
  return Math.max(0.5, v);
}

function getNodeZOrder(fields) {
  const arr = fields || [];
  const f = arr.find(x => String(x.key || '') === '覆盖顺序');
  if (!f) return 0;
  const v = parseFloat(String(f.value ?? '0'));
  if (!isFinite(v) || isNaN(v)) return 0;
  return Math.round(v);
}

function mapLink(l) {
  const isAuto = l.type === 'auto';
  const cls = isAuto ? 'auto auto-b' : 'manual dual';
  const override = edgeCpd.get(l.id);
  const hasCpd = Object.prototype.hasOwnProperty.call(l, 'cpd');
  const cpd = override != null ? override : (typeof l.cpd === 'number' ? l.cpd : 30);
  return { data: { id: l.id, source: l.source, target: l.target, label: l.label || '', cpd, cpdLocked: hasCpd }, classes: cls };
}

async function loadData() {
  // 图层视图：按图层取节点（位置由图层文件覆盖）；全局：取全部节点（主文件位置）
  const params = activeLayerId ? { params: { layer: activeLayerId } } : {};
  const { data } = await axios.get('/api/data', params);
  const nodes = (data.nodes || []).map(mapNode);
  const nodeIds = new Set((data.nodes || []).map(n => n.id));
  let edgeDefs = [...(data.links || []), ...(data.autoLinks || [])];
  // 图层视图下只保留两端都在该图层内的连线，避免悬空边导致 cytoscape 报错
  if (activeLayerId) {
    edgeDefs = edgeDefs.filter(l => nodeIds.has(l.source) && nodeIds.has(l.target));
  }
  const edges = edgeDefs.map(mapLink);
  return { nodes, edges, rawNodes: data.nodes };
}

function renderGraph(nodes, edges) {
  const container = document.getElementById('graph');
  let el = document.getElementById('cy');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cy';
    container.appendChild(el);
  }
  // 在捕获阶段阻止画布区域的浏览器原生右键菜单，避免与节点/图层右键菜单同时弹出
  if (container && !container.dataset.nativeCtxBlocked) {
    container.dataset.nativeCtxBlocked = '1';
    container.addEventListener('contextmenu', (ev) => ev.preventDefault(), true);
  }
  // Preserve viewport (pan/zoom) across re-renders
  const prev = cy ? { pan: cy.pan(), zoom: cy.zoom() } : null;
  const p = themePalette();
  cy = cytoscape({
    container: el,
    elements: { nodes, edges },
    layout: { name: 'preset' },
  boxSelectionEnabled: true,
  wheelSensitivity: 0.15,
  minZoom: 0.02,
  maxZoom: 4,
  style: [
  { selector: 'node', style: { 'background-color': '#9CA3AF', 'border-width': 2, 'border-color': p.nodeBorder } },
  { selector: 'node:selected', style: { 'border-color': 'data(selColor)', 'border-width': 4, 'shadow-blur': 12, 'shadow-color': 'data(selColor)', 'shadow-opacity': 0.8, 'shadow-offset-x': 0, 'shadow-offset-y': 0 } },
  { selector: 'edge', style: { 'curve-style': 'unbundled-bezier', 'edge-distances': 'node-position', 'line-color': p.edge, 'color': p.edgeText, 'width': 2, 'label': 'data(label)', 'font-size': 10, 'text-background-opacity': 1, 'text-background-color': p.labelBg, 'text-background-padding': 2, 'target-arrow-shape': 'triangle', 'target-arrow-color': p.edge, 'control-point-distance': 'data(cpd)', 'control-point-weight': 0.5, 'text-rotation': 'autorotate' } },
  // 聚焦模式：非邻域淡化
  { selector: 'node.faded', style: { 'opacity': 0.15, 'text-opacity': 0.2, 'events': 'no' } },
  { selector: 'edge.faded', style: { 'opacity': 0.12, 'text-opacity': 0.0, 'events': 'no' } },
  // 根据弧度方向微调文本，向上弯时上移 6px，向下弯时下移 6px
  { selector: 'edge[cpd > 0]', style: { 'text-margin-y': -6 } },
  { selector: 'edge[cpd < 0]', style: { 'text-margin-y': 6 } },
  { selector: 'edge.dual', style: { 'source-arrow-shape': 'triangle', 'source-arrow-color': p.edge } },
  { selector: 'edge.auto', style: { 'line-style': 'dashed' } },
  { selector: 'edge.auto-b', style: { 'source-arrow-shape': 'none' } },
    ]
  });

  if (prev) {
    try { cy.zoom(prev.zoom); cy.pan(prev.pan); } catch {}
  }

    // 平移/缩放后，重绘编组框位置（用 rAF 合批，避免频繁重建）
    const scheduleGroupsRender = () => {
      if (rafGroups) return;
      rafGroups = requestAnimationFrame(() => { rafGroups = null; renderGroups(); });
    };
    cy.on('pan zoom', scheduleGroupsRender);
    cy.on('position drag', 'node', scheduleGroupsRender);

    // 选中样式：在选中/取消时切换 CSS 类（用于更强的高亮效果）
    cy.on('select', 'node', (evt) => {
      try {
        const dom = document.querySelector(`[data-id="${evt.target.id()}"]`);
        // 若未使用 data-id，可直接依赖 Cytoscape 样式；这里额外添加类供自定义
      } catch {}
    });
    cy.on('unselect', 'node', (evt) => {
      try {
        const dom = document.querySelector(`[data-id="${evt.target.id()}"]`);
      } catch {}
    });

  // 应用边文本显示开关状态
  const labelToggle = document.getElementById('toggle-edge-labels');
  const showLabels = labelToggle ? !!labelToggle.checked : true;
  applyEdgeLabelVisibility(showLabels);

  cy.on('tap', 'node', (evt) => {
    const n = evt.target;
    const e = evt.originalEvent;
    // 支持 Ctrl/Shift 多选
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      if (n.selected()) n.unselect(); else n.select();
    } else {
      cy.nodes().unselect();
      n.select();
    }
    selectedNode = n;
    updateEditor(n.id());
    // link picking
    if (linkPick.length === 1 && linkPick[0] !== n.id()) {
      linkPick.push(n.id());
      finishLinkPick();
    }
    // 双击检测：仅双击同一节点才进入聚焦模式
    const now = Date.now();
    if (lastTapNodeId === n.id() && (now - lastTapTime) <= DOUBLE_TAP_MS) {
      focusNodeId = n.id();
      updateFocusBySelection();
      // 重置双击状态，避免三连击误触
      lastTapNodeId = null;
      lastTapTime = 0;
    } else {
      lastTapNodeId = n.id();
      lastTapTime = now;
      // 单击不改变聚焦状态（保持当前聚焦或无聚焦）
    }
  });

  // 节点右键菜单
  cy.on('cxttap', 'node', (evt) => {
    const n = evt.target;
    if (!n.selected()) {
      cy.nodes().unselect();
      n.select();
    }
    selectedNode = n;
    updateEditor(n.id());
    const e = evt.originalEvent || {};
    openNodeContextMenu(n.id(), e.clientX || 0, e.clientY || 0);
    if (typeof evt.preventDefault === 'function') evt.preventDefault();
    if (typeof evt.stopPropagation === 'function') evt.stopPropagation();
  });

  // 仅在用户完成拖拽后保存一次（含多选），并去抖，避免高频 PUT
  cy.on('dragfree', 'node', (evt) => {
    const union = cy.nodes(':selected').union(evt.target);
    union.forEach(n => { try { dragSaveIds.add(n.id()); } catch {} });
    if (dragSaveTimer) clearTimeout(dragSaveTimer);
    dragSaveTimer = setTimeout(async () => {
      const ids = Array.from(dragSaveIds);
      dragSaveIds.clear();
      dragSaveTimer = null;
      // 批量提交：合并为一次请求，便于撤销成为单个步骤
      try {
        const payload = ids.map(id => {
          const n = cy.getElementById(id);
          const pos = n ? n.position() : null;
          return pos ? { id, position: { x: pos.x, y: pos.y } } : null;
        }).filter(Boolean);
        if (!payload.length) return;
        // 图层视图：只写该图层的位置排版；全局视图：写主文件节点位置
        if (activeLayerId) {
          await axios.post(`/api/layers/${activeLayerId}/positions`, payload);
        } else {
          await axios.post('/api/nodes/positions', payload);
        }
      } catch {}
    }, 50);
  });

  // 在每次渲染后绑定：点击手动连线删除
  cy.on('tap', 'edge.manual', async (evt) => {
  if (focusNodeId && evt.target.hasClass('faded')) return;
    const edge = evt.target;
    const id = edge.id();
    if (confirm('删除该手动连接？')) {
      await axios.delete(`/api/links/${id}`);
      await refresh();
    }
  });

  // 点击自动连线：抑制该条自动关联
  cy.on('tap', 'edge.auto', async (evt) => {
  if (focusNodeId && evt.target.hasClass('faded')) return;
    const edge = evt.target;
    const a = edge.data('source');
    const b = edge.data('target');
    if (confirm('隐藏这条自动关联？(可在左侧列表中恢复)')) {
      await axios.post('/api/auto/suppress', { a, b });
      await refresh();
    }
  });

  // 点击空白处：取消选择并退出聚焦模式
  cy.on('tap', (evt) => {
    if (evt.target === cy) {
  cy.elements().unselect();
      selectedNode = null;
  focusNodeId = null; // 仅空白点击才退出聚焦
      const el = document.getElementById('node-editor');
      if (el) el.innerHTML = '<div class="hint">选择图中的一个节点以编辑字段。</div>';
      updateFocusBySelection();
    }
  });

  // Shift+拖动边：调整弧度（control-point-distance）
  let bending = null; // { id, base, startY, cls }
  let bendPrev = null; // { pan, box, unselect }
  cy.on('vmousedown', 'edge', (evt) => {
    const e = evt.originalEvent;
    if (!e || !(e.shiftKey || e.metaKey || e.ctrlKey)) return;
    const edge = evt.target;
    bending = { id: edge.id(), base: Number((edge.data('cpd') ?? 30)), startY: e.clientY, cls: edge.hasClass('manual') ? 'manual' : 'auto' };
    // 暂时禁用平移/框选，避免与 Cytoscape 冲突
    bendPrev = { pan: cy.userPanningEnabled(), box: cy.boxSelectionEnabled(), unselect: cy.autounselectify() };
    cy.userPanningEnabled(false);
    cy.boxSelectionEnabled(false);
    cy.autounselectify(true);
    evt.preventDefault();
    evt.stopPropagation();
    // 提示手势
    document.body.style.cursor = 'ns-resize';
  });
  cy.on('vmousemove', (evt) => {
    if (!bending) return;
    const e = evt.originalEvent;
    const delta = bending.startY - e.clientY; // 向上增大
    const next = Math.max(-400, Math.min(400, Math.round(bending.base + delta)));
    const edge = cy.getElementById(bending.id);
    if (edge && edge.nonempty()) {
      edge.data('cpd', next);
    }
    evt.preventDefault();
    evt.stopPropagation();
  });
  cy.on('vmouseup', async () => {
    if (!bending) return;
    const edge = cy.getElementById(bending.id);
    const val = edge ? Number((edge.data('cpd') ?? 30)) : bending.base;
    edgeCpd.set(bending.id, val);
    // 持久化：手动边保存到 links；自动边保存到 overrides
    try {
      const ele = edge;
      if (ele && ele.hasClass('manual')) {
        await axios.put(`/api/links/${bending.id}`, { cpd: val });
      } else if (ele && ele.hasClass('auto')) {
        await axios.post('/api/auto/edge/cpd', { source: ele.data('source'), target: ele.data('target'), cpd: val });
      }
    } catch {}
    bending = null;
    // 恢复 Cytoscape 行为
    if (bendPrev) {
      try {
        cy.userPanningEnabled(!!bendPrev.pan);
        cy.boxSelectionEnabled(!!bendPrev.box);
        cy.autounselectify(!!bendPrev.unselect);
      } catch {}
      bendPrev = null;
    }
    document.body.style.cursor = '';
  });
}

// ===== 视图筛选：搜索 + 分组视图统一显隐 =====
// 解析搜索框表达式，返回匹配节点 id 集合；空搜索返回 null（表示不限制）
function getSearchMatchedIds(q) {
  if (!q) return null;
  const raws = Array.isArray(window.__rawNodes) ? window.__rawNodes : [];
  const norm = q
    .replaceAll('||', ' OR ').replaceAll('或', ' OR ')
    .replaceAll('&&', ' AND ').replaceAll('与', ' AND ')
    .replace(/\s+/g, ' ').trim();
  const orGroups = norm.split(/\sOR\s/i);
  const idSet = new Set();
  const matchTerm = (node, term) => {
    term = term.trim();
    if (!term) return false;
    const fields = node.fields || [];
    const has = (pred) => fields.some(pred);
    if (term.toLowerCase().startsWith('key:')) return has(f => String(f.key || '').includes(term.slice(4)));
    if (term.toLowerCase().startsWith('value:')) return has(f => String(f.value || '').includes(term.slice(6)));
    const idx = term.indexOf(':');
    if (idx > 0) {
      const kpat = term.slice(0, idx), vpat = term.slice(idx + 1);
      return has(f => String(f.key || '').includes(kpat) && String(f.value || '').includes(vpat));
    }
    return has(f => String(f.value || '').includes(term));
  };
  const groupMatches = (node, group) => group.split(/\sAND\s|\s+/i).filter(Boolean).every(t => matchTerm(node, t));
  raws.forEach(n => { if (orGroups.some(g => groupMatches(n, g))) idSet.add(n.id); });
  return idSet;
}

// 若当前查看的图层已被删除，回退到全局浏览
function ensureLayerValid() {
  if (activeLayerId && !cachedLayers.some(l => l.id === activeLayerId)) {
    activeLayerId = null;
    return true;
  }
  return false;
}

// 搜索框的匹配结果（图层成员已由数据层过滤，这里只做显示层叠加）
function computeAllowedIds() {
  const q = (document.getElementById('search')?.value || '').trim();
  return getSearchMatchedIds(q);
}

// 编组框与角标：仅全局浏览时按开关显示；图层视图下始终隐藏
function syncGroupOverlay() {
  const show = !activeLayerId && showGroupBoxes;
  groupDomCache.forEach((entry) => {
    if (entry.path) entry.path.style.display = show ? '' : 'none';
    if (entry.label) entry.label.style.display = show ? '' : 'none';
  });
  groupBadgeCache.forEach((badge) => {
    if (badge) badge.style.display = show ? '' : 'none';
  });
}

// 统一应用视图筛选：仅按搜索结果显隐（节点集合由当前图层/全局决定），auto 边沿用自动关联筛选
function applyViewFilter() {
  if (!cy) return;
  const allowed = computeAllowedIds();
  cy.batch(() => {
    cy.nodes().forEach(n => n.style('display', (!allowed || allowed.has(n.id())) ? 'element' : 'none'));
    cy.edges().forEach(e => {
      if (e.hasClass('auto')) return; // auto 边由自动关联筛选单独控制
      const s = e.source().id(), t = e.target().id();
      const visible = !allowed || (allowed.has(s) && allowed.has(t));
      e.style('display', visible ? 'element' : 'none');
    });
  });
  applyAutoEdgeFilter();
  syncGroupOverlay();
  updateFocusBySelection();
}

async function refreshLayersCache() {
  try {
    const { data } = await axios.get('/api/layers');
    cachedLayers = Array.isArray(data) ? data : [];
  } catch { cachedLayers = []; }
  ensureLayerValid();
}

// 展开/折叠的文件夹 id 集合
const collapsedFolders = new Set();

// 判断拖拽是否合法：不能拖到自己/自己的后代里，目标必须是文件夹（或全局）
function canMoveLayer(id, parentId) {
  if (!id || id === parentId) return false;
  if (!cachedLayers.some(l => l.id === id)) return false;
  if (!parentId) return true;
  const parent = cachedLayers.find(l => l.id === parentId && l.kind === 'folder');
  if (!parent) return false;
  let cur = parentId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    if (cur === id) return false;
    seen.add(cur);
    cur = (cachedLayers.find(l => l.id === cur) || {}).parentId;
  }
  return true;
}

function renderLayerPanel() {
  const list = document.getElementById('gvp-list');
  if (!list) return;
  list.innerHTML = '';
  const clearDropHints = () => list.querySelectorAll('.drop-hover').forEach(el => el.classList.remove('drop-hover'));

  const attachDropTarget = (btn, parentId) => {
    btn.ondragover = (ev) => {
      if (!dragSourceId || !canMoveLayer(dragSourceId, parentId)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      btn.classList.add('drop-hover');
    };
    btn.ondragleave = () => btn.classList.remove('drop-hover');
    btn.ondrop = (ev) => {
      ev.preventDefault();
      btn.classList.remove('drop-hover');
      const id = dragSourceId || (ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : '');
      dragSourceId = null;
      if (id) moveLayerToParent(id, parentId);
    };
  };

  const makeRow = (label, opts = {}) => {
    const { value = null, kind = 'layer', color = null, count = null, depth = 0, active = false } = opts;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gvp-item'
      + (active ? ' active' : '')
      + (kind === 'folder' ? ' gvp-folder' : '')
      + (value && value === contextTargetId ? ' context-target' : '');
    btn.style.paddingLeft = (9 + depth * 14) + 'px';
    if (kind === 'folder') {
      const arrow = document.createElement('span');
      arrow.className = 'gvp-arrow';
      arrow.textContent = collapsedFolders.has(value) ? '▸' : '▾';
      btn.appendChild(arrow);
    } else if (color) {
      const dot = document.createElement('span'); dot.className = 'gvp-dot'; dot.style.background = color; btn.appendChild(dot);
    }
    const name = document.createElement('span'); name.className = 'gvp-name'; name.textContent = label; btn.appendChild(name);
    if (typeof count === 'number') { const c = document.createElement('span'); c.className = 'gvp-count'; c.textContent = String(count); btn.appendChild(c); }
    if (kind === 'global') {
      const sw = document.createElement('label');
      sw.className = 'gvp-switch';
      sw.title = '显示 / 隐藏画布上的编组彩色框';
      const caption = document.createElement('span');
      caption.className = 'gvp-switch-label';
      caption.textContent = '编组框';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = showGroupBoxes;
      input.setAttribute('aria-label', '显示编组彩色框');
      const track = document.createElement('span');
      track.className = 'gvp-switch-track';
      sw.append(caption, input, track);
      sw.onclick = (ev) => ev.stopPropagation();
      input.onchange = () => {
        showGroupBoxes = input.checked;
        try { localStorage.setItem(GROUP_BOXES_STORAGE_KEY, showGroupBoxes ? '1' : '0'); } catch {}
        syncGroupOverlay();
      };
      btn.appendChild(sw);
    }
    btn.onclick = () => {
      if (kind === 'folder') {
        contextTargetId = value;
        collapsedFolders.has(value) ? collapsedFolders.delete(value) : collapsedFolders.add(value);
        renderLayerPanel();
      } else if (kind === 'layer') {
        contextTargetId = value;
        setActiveLayer(value);
      } else {
        contextTargetId = null;
        setActiveLayer(null);
      }
    };
    btn.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (kind === 'global') return;
      contextTargetId = value;
      renderLayerPanel();
      openLayerContextMenu(value, ev.clientX, ev.clientY);
    };
    if (value) {
      btn.dataset.layerId = value;
      btn.draggable = true;
      btn.ondragstart = (ev) => {
        dragSourceId = value;
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move';
          try { ev.dataTransfer.setData('text/plain', value); } catch {}
        }
        btn.classList.add('dragging');
      };
      btn.ondragend = () => {
        btn.classList.remove('dragging');
        dragSourceId = null;
        clearDropHints();
      };
    }
    if (kind === 'folder' || kind === 'global') attachDropTarget(btn, value);
    list.appendChild(btn);
    return btn;
  };

  makeRow('全局浏览', { value: null, kind: 'global', color: '#9ca3af', active: !activeLayerId });
  if (!cachedLayers.length) {
    const empty = document.createElement('div');
    empty.className = 'gvp-empty'; empty.textContent = '暂无图层，点下方按钮创建';
    list.appendChild(empty);
    return;
  }
  const childrenOf = (pid) => cachedLayers.filter(l => (l.parentId || null) === pid);
  const renderChildren = (parentId, depth) => {
    childrenOf(parentId).forEach(l => {
      const isFolder = l.kind === 'folder';
      const kids = isFolder ? childrenOf(l.id) : [];
      makeRow(l.label || (isFolder ? '文件夹' : '图层'), {
        value: l.id, kind: isFolder ? 'folder' : 'layer',
        color: l.color || '#3b82f6',
        count: isFolder ? kids.length : (l.members || []).length,
        depth, active: !isFolder && l.id === activeLayerId,
      });
      if (isFolder && !collapsedFolders.has(l.id)) renderChildren(l.id, depth + 1);
    });
  };
  renderChildren(null, 0);
}

async function setActiveLayer(id) {
  if (activeLayerId === (id || null)) return;
  activeLayerId = id || null;
  renderLayerPanel();
  await refresh(false); // 用目标图层的专属位置重新渲染，不保留上一视图位置
  const vis = cy ? cy.nodes().filter(n => n.style('display') !== 'none') : null;
  if (cy && vis && vis.length) cy.animate({ fit: { eles: vis, padding: 90 }, duration: 300 });
}

function closeLayerContextMenu() {
  const menu = document.getElementById('layer-context-menu');
  if (!menu) return;
  menu.hidden = true;
  menu.innerHTML = '';
}

function openLayerContextMenu(id, x, y) {
  const menu = document.getElementById('layer-context-menu');
  const layer = cachedLayers.find(l => l.id === id);
  if (!menu || !layer) return;
  closeNodeContextMenu();
  const isFolder = layer.kind === 'folder';
  const label = layer.label || (isFolder ? '文件夹' : '图层');
  const items = isFolder ? [
    { label: '重命名文件夹', action: () => renameLayer(id) },
    { label: '复制文件夹（含子项）', action: () => duplicateLayer(id) },
    { label: '在此新建子文件夹', action: () => createFolder(id) },
    { sep: true },
    { label: '解散文件夹（子项保留）', action: () => dissolveLayer(id) },
    { label: '删除文件夹及全部子项', danger: true, action: () => deleteLayerTree(id) },
  ] : [
    { label: '切换到此图层', action: () => setActiveLayer(id) },
    { label: '重命名图层', action: () => renameLayer(id) },
    { label: '复制图层（含排版）', action: () => duplicateLayer(id) },
    { sep: true },
    { label: '加入当前选中节点', action: () => changeLayerMembers(id, true) },
    { label: '移出当前选中节点', action: () => changeLayerMembers(id, false) },
    { label: '归类到文件夹…', action: () => setLayerParent(id) },
    ...(layer.parentId ? [{ label: '移出文件夹', action: () => moveLayerToParent(id, null) }] : []),
    { sep: true },
    { label: '解散图层成员（清空）', action: () => dissolveLayer(id) },
    { label: '删除图层', danger: true, action: () => deleteLayer(id) },
  ];

  menu.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.textContent = label;
  menu.appendChild(title);
  items.forEach(item => {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    if (item.danger) btn.className = 'danger';
    btn.onclick = async () => {
      closeLayerContextMenu();
      await item.action();
    };
    menu.appendChild(btn);
  });
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
}

// ===== 画布节点右键菜单 =====
function closeNodeContextMenu() {
  const menu = document.getElementById('node-context-menu');
  if (!menu) return;
  menu.hidden = true;
  menu.innerHTML = '';
}

function shortNodeLabel(id) {
  const raw = getNodeById(id);
  const fields = (raw && raw.fields) || [];
  const nameField = fields.find(f => f && String(f.key || '') === '名称')
    || fields.find(f => f && String(f.type || '') === 'text' && f.value);
  const value = nameField && nameField.value ? String(nameField.value) : '';
  return value ? (value.length > 18 ? value.slice(0, 18) + '…' : value) : String(id || '').slice(0, 8);
}

async function addNodeToLayer(nodeId, layerId) {
  const layer = cachedLayers.find(l => l.id === layerId && l.kind === 'layer');
  if (!layer) return;
  const members = new Set(layer.members || []);
  members.add(nodeId);
  await axios.put(`/api/layers/${layerId}`, { members: Array.from(members) });
  const n = cy ? cy.getElementById(nodeId) : null;
  if (n && n.nonempty()) {
    const p = n.position();
    await axios.post(`/api/layers/${layerId}/positions`, [{ id: nodeId, position: { x: p.x, y: p.y } }]);
  }
  await syncLayerChange();
}

async function removeNodeFromCurrentLayer(nodeId) {
  if (!activeLayerId) return;
  const layer = cachedLayers.find(l => l.id === activeLayerId);
  if (!layer) return;
  const members = (layer.members || []).filter(id => id !== nodeId);
  await axios.put(`/api/layers/${activeLayerId}`, { members });
  await syncLayerChange(true);
}

async function deleteNodeById(nodeId) {
  const label = shortNodeLabel(nodeId);
  if (!confirm(`删除节点「${label}」？\n相关连线会一并删除，其他图层中的引用也会清理。`)) return;
  await axios.delete(`/api/nodes/${nodeId}`);
  if (contextTargetId === nodeId) contextTargetId = null;
  await refresh(false);
}

function openNodeContextMenu(id, x, y) {
  const menu = document.getElementById('node-context-menu');
  if (!menu || !id) return;
  closeLayerContextMenu();
  const items = [
    { label: '复制节点', action: () => (window.duplicateSelectedNode ? window.duplicateSelectedNode() : Promise.resolve()) },
    { label: '删除节点', danger: true, action: () => deleteNodeById(id) },
  ];
  if (activeLayerId) {
    items.push({ sep: true });
    items.push({ label: '从当前图层移出', action: () => removeNodeFromCurrentLayer(id) });
  }
  items.push({ sep: true });
  items.push({ group: '加入已有图层 / 文件夹' });

  const layerCount = cachedLayers.filter(l => l.kind === 'layer').length;
  if (!layerCount) {
    items.push({ text: '暂无图层，请先创建一个图层' });
  } else {
    const appendChildren = (parentId, depth) => {
      cachedLayers
        .filter(l => l.kind === 'folder' && (l.parentId || null) === parentId)
        .forEach(f => {
          items.push({ group: `▾ ${f.label || '文件夹'}`, depth });
          appendChildren(f.id, depth + 1);
        });
      cachedLayers
        .filter(l => l.kind === 'layer' && (l.parentId || null) === parentId)
        .forEach(l => {
          const already = (l.members || []).includes(id);
          items.push({ layerId: l.id, label: `${already ? '✓ ' : '● '}${l.label || '图层'}`, depth, color: l.color });
        });
    };
    appendChildren(null, 0);
  }

  menu.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.textContent = `节点：${shortNodeLabel(id)}`;
  menu.appendChild(title);
  items.forEach(item => {
    if (item.sep) {
      const sep = document.createElement('div'); sep.className = 'menu-sep'; menu.appendChild(sep); return;
    }
    if (item.group) {
      const g = document.createElement('div');
      g.className = 'menu-group';
      g.textContent = item.group;
      g.style.paddingLeft = (10 + (item.depth || 0) * 12) + 'px';
      menu.appendChild(g);
      return;
    }
    if (item.text) {
      const t = document.createElement('div');
      t.className = 'menu-empty';
      t.textContent = item.text;
      menu.appendChild(t);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    btn.style.paddingLeft = (10 + (item.depth || 0) * 12) + 'px';
    if (item.danger) btn.className = 'danger';
    if (item.color) btn.style.borderLeft = `3px solid ${item.color}`;
    btn.onclick = async () => {
      closeNodeContextMenu();
      if (item.layerId) await addNodeToLayer(id, item.layerId);
      else await item.action();
    };
    menu.appendChild(btn);
  });
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
}

let layerContextListenersReady = false;
function setupLayerPanel() {
  const toggle = document.getElementById('gvp-toggle');
  const panel = document.getElementById('group-view-panel');
  if (toggle && panel && !toggle.dataset.bound) {
    toggle.dataset.bound = '1';
    toggle.onclick = () => {
      const collapsed = panel.classList.toggle('collapsed');
      toggle.textContent = collapsed ? '+' : '−';
    };
  }
  if (!layerContextListenersReady) {
    layerContextListenersReady = true;
    document.addEventListener('click', (ev) => {
      const layerMenu = document.getElementById('layer-context-menu');
      const nodeMenu = document.getElementById('node-context-menu');
      if (layerMenu && !layerMenu.hidden && !layerMenu.contains(ev.target)) closeLayerContextMenu();
      if (nodeMenu && !nodeMenu.hidden && !nodeMenu.contains(ev.target)) closeNodeContextMenu();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { closeLayerContextMenu(); closeNodeContextMenu(); }
    });
    const closeBoth = () => { closeLayerContextMenu(); closeNodeContextMenu(); };
    window.addEventListener('resize', closeBoth);
    const list = document.getElementById('gvp-list');
    if (list) list.addEventListener('scroll', closeBoth, true);
  }
  const bind = (id, handler) => {
    const el = document.getElementById(id);
    if (el && !el.dataset.bound) { el.dataset.bound = '1'; el.onclick = handler; }
  };
  bind('gvp-new-layer', () => createLayerFromSelection());
  bind('gvp-new-folder', () => createFolder());
  renderLayerPanel();
}

// 当前选中节点 id
function selectedNodeIds() {
  const sel = cy ? cy.nodes(':selected') : null;
  return sel ? sel.map(n => n.id()) : [];
}

// 图层/文件夹增删改后同步缓存与面板；reloadGraph=true 时重新按图层取节点
async function syncLayerChange(reloadGraph = false) {
  await refreshLayersCache();
  renderLayerPanel();
  if (reloadGraph) await refresh(false);
}

async function createLayerFromSelection() {
  const ids = selectedNodeIds();
  if (!ids.length) { alert('请先选中一个或多个节点，再新建图层（会以这些节点及其当前位置初始化图层）。'); return; }
  const label = prompt('新图层名称：', `图层 ${cachedLayers.filter(l => l.kind === 'layer').length + 1}`);
  if (!label) return;
  const { data } = await axios.post('/api/layers', { kind: 'layer', label, members: ids, snapshot: true });
  await refreshLayersCache();
  renderLayerPanel();
  await setActiveLayer(data.id);
}

async function createFolder(parentId = null) {
  const label = prompt('新文件夹名称：', `文件夹 ${cachedLayers.filter(l => l.kind === 'folder').length + 1}`);
  if (!label) return;
  await axios.post('/api/layers', { kind: 'folder', label, parentId });
  await syncLayerChange();
}

async function changeLayerMembers(id, add) {
  const layer = cachedLayers.find(l => l.id === id);
  if (!layer) return;
  const ids = selectedNodeIds();
  if (!ids.length) { alert('请先选中节点。'); return; }
  const members = new Set(layer.members || []);
  ids.forEach(mid => add ? members.add(mid) : members.delete(mid));
  await axios.put(`/api/layers/${id}`, { members: Array.from(members) });
  await syncLayerChange(activeLayerId === id);
}

async function renameLayer(id) {
  const layer = cachedLayers.find(l => l.id === id);
  if (!layer) return;
  const label = prompt(layer.kind === 'folder' ? '重命名文件夹：' : '重命名图层：', layer.label || '');
  if (!label) return;
  await axios.put(`/api/layers/${id}`, { label });
  await syncLayerChange();
}

async function moveLayerToParent(id, parentId) {
  if (!canMoveLayer(id, parentId)) return;
  await axios.put(`/api/layers/${id}`, { parentId });
  await syncLayerChange();
}

async function setLayerParent(id) {
  const layer = cachedLayers.find(l => l.id === id);
  if (!layer) return;
  const folders = cachedLayers.filter(f => f.kind === 'folder' && canMoveLayer(id, f.id));
  const options = [['0', '（顶层，不归类）'], ...folders.map(f => [f.id, f.label || '文件夹'])];
  const lines = options.map(([fid, label], i) => `${i + 1}. ${label}`).join('\n');
  const answer = prompt(`把「${layer.label || '图层'}」归类到：\n${lines}\n\n输入序号：`, '1');
  if (!answer) return;
  const idx = parseInt(answer, 10) - 1;
  if (!(idx >= 0 && idx < options.length)) { alert('无效序号'); return; }
  await moveLayerToParent(id, options[idx][0] === '0' ? null : options[idx][0]);
}

async function duplicateLayer(id) {
  const layer = cachedLayers.find(l => l.id === id);
  if (!layer) return;
  await axios.post(`/api/layers/${id}/duplicate`);
  await syncLayerChange();
}

async function dissolveLayer(id) {
  const layer = cachedLayers.find(l => l.id === id);
  if (!layer) return;
  if (layer.kind === 'folder') {
    if (!confirm(`解散文件夹「${layer.label || '文件夹'}」？\n其中的图层/文件夹会保留并移到上一层。`)) return;
  } else {
    if (!confirm(`解散图层「${layer.label || '图层'}」的成员？\n图层与排版定义会保留，节点仍留在全局。`)) return;
  }
  await axios.post(`/api/layers/${id}/dissolve`);
  await syncLayerChange(activeLayerId === id);
}

async function deleteLayer(id) {
  const layer = cachedLayers.find(l => l.id === id);
  if (!layer) return;
  if (!confirm(`删除${layer.kind === 'folder' ? '文件夹' : '图层'}「${layer.label || ''}」？\n节点本身不会被删除。`)) return;
  await axios.delete(`/api/layers/${id}`);
  if (activeLayerId === id) activeLayerId = null;
  if (contextTargetId === id) contextTargetId = null;
  await syncLayerChange(true);
}

async function deleteLayerTree(id) {
  const layer = cachedLayers.find(l => l.id === id);
  if (!layer) return;
  if (!confirm(`删除文件夹「${layer.label || ''}」及其中全部子项？\n节点本身不会被删除，只会删除这些排版图层。`)) return;
  await axios.post(`/api/layers/${id}/delete-tree`);
  if (activeLayerId === id || (cachedLayers.find(l => l.id === activeLayerId) || {}).parentId === id) activeLayerId = null;
  if (contextTargetId === id) contextTargetId = null;
  await syncLayerChange(true);
}

async function refresh(preservePositions = true) {
  const { nodes, edges, rawNodes } = await loadData();
  // 可选：保持当前已存在节点的位置，避免因服务端未及时保存导致位置回弹
  if (preservePositions) {
    try {
      if (cy) {
        const posMap = new Map();
        cy.nodes().forEach(n => { const p = n.position(); posMap.set(n.id(), { x: p.x, y: p.y }); });
        nodes.forEach(nd => { const p = posMap.get(nd.data.id); if (p) nd.position = p; });
      }
    } catch {}
  }
  renderGraph(nodes, edges);
  window.__rawNodes = rawNodes;
  await renderSuppressed();
  await updateHistoryButtons();
  // 渲染后根据当前选择应用聚焦态
  applyAutoEdgeFilter();
  updateFocusBySelection();
  // 同步编组缓存并渲染群组
  await refreshGroupsCache();
  renderGroups();
  await refreshLayersCache();
  setupLayerPanel();
  applyViewFilter();
}

function editorHtml(node) {
  const fields = node.fields || [];
  const editableFields = fields.filter(f => !['大小倍率', '覆盖顺序'].includes(String(f?.key || '')));
  const scaleVal = getSizeScale(fields);
  const zOrderVal = getNodeZOrder(fields);
  return `
    <div>
  <div class="muted" style="margin-bottom:6px;">ID: ${(node.id ?? '').toString().replace(/</g,'&lt;')}</div>
      <div class="field-row field-row-scale">
        <label for="size-scale">大小倍率</label>
        <input id="size-scale" type="number" step="0.1" min="0.5" value="${scaleVal}" />
      </div>
      <div class="field-row field-row-scale">
        <label for="node-z-order">&#35206;&#30422;&#39034;&#24207;</label>
        <input id="node-z-order" type="number" step="1" value="${zOrderVal}" />
      </div>
      ${editableFields.map((f, i) => `
        <div class="field-row">
          <input data-k ${attr('value', f.key)} placeholder="字段名">
          <select data-t>
            ${opt('text', f.type)}
            ${opt('tag', f.type)}
            ${opt('ref', f.type)}
            ${opt('number', f.type)}
          </select>
          ${f.type === 'text'
            ? `<textarea data-v placeholder="值">${(f.value ?? '').toString().replace(/</g,'&lt;')}</textarea>`
            : `<input data-v ${attr('value', f.value)} placeholder="值">`
          }
          <button data-del>删除</button>
        </div>
      `).join('')}
      <div style="margin:8px 0; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <button id="add-field">+ 添加字段</button>
        <span id="save-status" class="muted" style="font-size:12px;">修改后自动保存</span>
      </div>
      <button id="delete-node" style="color:#b91c1c">删除该节点</button>
    </div>
  `;
}

function attr(name, value) { return value != null ? `${name}="${String(value).replaceAll('"','&quot;')}"` : ''; }
function opt(v, cur) { return `<option value="${v}" ${v===cur?'selected':''}>${v}</option>` }

function getNodeById(id) { return (window.__rawNodes || []).find(n => n.id === id); }

// ===== 节点字段自动保存 =====
// 读取编辑栏当前所有字段（含大小倍率、覆盖顺序）
function collectEditorFields(el, keepEmpty = false) {
  const rows = [...el.querySelectorAll('.field-row')];
  const list = rows.filter(r => r.querySelector('[data-k]')).map(r => ({
    key: r.querySelector('[data-k]').value.trim(),
    type: r.querySelector('[data-t]').value,
    value: r.querySelector('[data-v]').value,
  })).filter(f => keepEmpty || f.key);
  const scaleInput = el.querySelector('#size-scale');
  if (scaleInput) {
    const sc = Math.max(0.5, parseFloat(scaleInput.value || '1') || 1);
    const idx = list.findIndex(f => String(f.key) === '大小倍率');
    if (idx >= 0) list[idx] = { key: '大小倍率', type: 'number', value: String(sc) };
    else list.unshift({ key: '大小倍率', type: 'number', value: String(sc) });
  }
  const zOrderInput = el.querySelector('#node-z-order');
  if (zOrderInput) {
    const z = Math.round(parseFloat(zOrderInput.value || '0') || 0);
    const idx = list.findIndex(f => String(f.key) === '覆盖顺序');
    if (idx >= 0) list[idx] = { key: '覆盖顺序', type: 'number', value: String(z) };
    else list.unshift({ key: '覆盖顺序', type: 'number', value: String(z) });
  }
  return list;
}

let fieldSaveTimer = null;
let fieldSaveGeneration = 0;

function setSaveStatus(text, isError) {
  const st = document.querySelector('#node-editor #save-status');
  if (!st) return;
  st.textContent = text;
  st.style.color = isError ? 'var(--color-text-danger, #b91c1c)' : '';
}

// 提交字段到后端并刷新图谱；rebuildEditor=false 以避免输入时编辑器重建导致失焦
async function persistEditorFields(id, el, rebuildEditor = false) {
  const list = collectEditorFields(el);
  const gen = ++fieldSaveGeneration;
  setSaveStatus('保存中…');
  try {
    await axios.put(`/api/nodes/${id}`, { fields: list });
    await refresh();
    if (gen !== fieldSaveGeneration) return;
    if (rebuildEditor) {
      updateEditor(id);
      return;
    }
    selectedNode = cy && cy.getElementById(id);
    if (selectedNode && selectedNode.nonempty && selectedNode.nonempty()) selectedNode.select();
    setSaveStatus('已自动保存');
  } catch (e) {
    if (gen === fieldSaveGeneration) setSaveStatus('保存失败', true);
    console.error(e);
  }
}

// 输入防抖：停止输入 500ms 后自动提交
function scheduleFieldSave(id, el) {
  if (fieldSaveTimer) clearTimeout(fieldSaveTimer);
  setSaveStatus('正在输入…');
  fieldSaveTimer = setTimeout(() => {
    fieldSaveTimer = null;
    persistEditorFields(id, el, false);
  }, 500);
}

function updateEditor(id) {
  const node = getNodeById(id);
  const el = document.getElementById('node-editor');
  if (!node) { el.innerHTML = '<div class="hint">未找到节点。</div>'; return; }
  // 切换节点前先冲刷上一个节点尚未到期的自动保存，避免丢改动
  if (fieldSaveTimer) {
    clearTimeout(fieldSaveTimer);
    const pendingId = el.dataset.nodeId;
    const pendingEl = el;
    fieldSaveTimer = null;
    if (pendingId && pendingId !== id) axios.put(`/api/nodes/${pendingId}`, { fields: collectEditorFields(pendingEl) }).catch(() => {});
  }
  el.dataset.nodeId = id;
  el.innerHTML = editorHtml(node);

  // 字段名、字段值、大小倍率、覆盖顺序：输入防抖自动保存
  el.querySelectorAll('[data-k], [data-v], #size-scale, #node-z-order').forEach(inp => {
    inp.addEventListener('input', () => scheduleFieldSave(id, el));
  });
  // 字段类型变更会改变值控件的形态（textarea <-> input），需保存后重建编辑栏
  el.querySelectorAll('[data-t]').forEach(sel => {
    sel.addEventListener('change', () => {
      if (fieldSaveTimer) { clearTimeout(fieldSaveTimer); fieldSaveTimer = null; }
      persistEditorFields(id, el, true);
    });
  });

  // 自动高度：对所有 textarea 进行自适应
  el.querySelectorAll('textarea[data-v]').forEach(t => {
    const auto = () => { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; };
    t.addEventListener('input', auto);
    auto();
  });
  el.querySelector('#add-field').onclick = async () => {
    const n = getNodeById(id) || node;
    const list = collectEditorFields(el);
    list.push({ key: '', type: 'text', value: '' });
    fieldSaveGeneration++;
    if (fieldSaveTimer) { clearTimeout(fieldSaveTimer); fieldSaveTimer = null; }
    await axios.put(`/api/nodes/${id}`, { fields: list });
    await refresh();
    updateEditor(id);
  };
  el.querySelector('#delete-node').onclick = async () => {
    if (!confirm('确认删除该节点？')) return;
    if (fieldSaveTimer) { clearTimeout(fieldSaveTimer); fieldSaveTimer = null; }
    await axios.delete(`/api/nodes/${id}`);
    selectedNode = null;
    const editor = document.getElementById('node-editor');
    editor.dataset.nodeId = '';
    editor.innerHTML = '<div class="hint">选择图中的一个节点以编辑字段。</div>';
    await refresh();
  };
  el.querySelectorAll('[data-del]').forEach((btn, idx) => btn.onclick = async () => {
    const list = collectEditorFields(el, true);
    list.splice(idx, 1);
    fieldSaveGeneration++;
    if (fieldSaveTimer) { clearTimeout(fieldSaveTimer); fieldSaveTimer = null; }
    await axios.put(`/api/nodes/${id}`, { fields: list });
    await refresh();
    updateEditor(id);
  });
}

async function finishLinkPick() {
  const [a, b] = linkPick;
  linkPick = [];
  document.getElementById('link-status').textContent = '';
  const label = prompt('为该连线添加备注（可留空）：') || '';
  await axios.post('/api/links', { source: a, target: b, label });
  await refresh();
}

async function initTemplates() {
  const { data } = await axios.get('/api/templates');
  const sel = document.getElementById('template-select');
  sel.innerHTML = '<option value="">选择模板</option>' + Object.keys(data).map(k => `<option value="${k}">${k}</option>`).join('');
  sel.dataset.templates = JSON.stringify(data);
}

function renderGroups() {
  const groups = Array.isArray(cachedGroups) ? cachedGroups : [];
  const container = document.getElementById('graph');
  if (!container || !cy) return;
  const pan = cy.pan(); const zoom = cy.zoom() || 1;
  const toScreen = (p) => ({ x: p.x * zoom + pan.x, y: p.y * zoom + pan.y });
  const hexToRgba = (hex, alpha) => {
    try {
      if (!hex) return `rgba(59,130,246,${alpha ?? 0.08})`;
      let h = hex.trim();
      if (h.startsWith('#')) h = h.slice(1);
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      const r = parseInt(h.slice(0,2), 16);
      const g = parseInt(h.slice(2,4), 16);
      const b = parseInt(h.slice(4,6), 16);
      const a = (typeof alpha === 'number' ? alpha : 0.08);
      return `rgba(${r},${g},${b},${a})`;
    } catch { return `rgba(59,130,246,${alpha ?? 0.08})`; }
  };
  const updateBox = (els, color, opacity, box, labelEl) => {
    const pad = 30;
    const bb = els.boundingBox();
    const tl = toScreen({ x: bb.x1 - pad, y: bb.y1 - pad });
    const br = toScreen({ x: bb.x2 + pad, y: bb.y2 + pad });
    box.style.left = tl.x + 'px';
    box.style.top = tl.y + 'px';
    box.style.width = (br.x - tl.x) + 'px';
    box.style.height = (br.y - tl.y) + 'px';
    box.style.background = hexToRgba(color, opacity);
    box.style.border = `1px dashed ${color}`;
    if (labelEl) {
      labelEl.style.left = (tl.x + 8) + 'px';
      labelEl.style.top = (tl.y + 4) + 'px';
    }
  };
  const activeKeys = new Set();
  groups.forEach((g, idx) => {
    const ids = (g.members || []).filter(Boolean);
    const eles = cy.collection(ids.map(id => cy.getElementById(id))).filter('node');
    if (!eles || eles.length === 0) return;
    const color = g.color || '#3b82f6';
    const opacity = (typeof g.opacity === 'number') ? g.opacity : 0.08;
    const key = g.id != null ? String(g.id) : `__auto_${ids.slice().sort().join('|')}_${g.label || ''}`;
    let entry = groupDomCache.get(key);
    if (!entry) {
      const box = document.createElement('div');
      box.className = 'group-box';
      box.style.position = 'absolute';
      box.style.borderRadius = '8px';
      box.style.pointerEvents = 'none';
      box.style.userSelect = 'none';
      box.style.zIndex = 2;

      const lbl = document.createElement('div');
      lbl.className = 'group-label';
      lbl.style.position = 'absolute';
      lbl.style.padding = '2px 6px';
      const theme = themePalette();
      lbl.style.background = theme.groupLabelBg;
      lbl.style.border = `1px solid ${theme.groupLabelBorder}`;
      lbl.style.color = theme.groupLabelText;
      lbl.style.borderRadius = '6px';
      lbl.style.fontSize = '12px';
      lbl.style.cursor = 'move';
      lbl.style.zIndex = 3;

      entry = { box, label: lbl };
      groupDomCache.set(key, entry);
    }

    const { box, label } = entry;
    const currentTheme = themePalette();
    label.style.background = currentTheme.groupLabelBg;
    label.style.border = `1px solid ${currentTheme.groupLabelBorder}`;
    label.style.color = currentTheme.groupLabelText;
    if (!box.isConnected) container.appendChild(box);
    if (!label.isConnected) container.appendChild(label);

    label.textContent = g.label || '编组';
    label.dataset.groupKey = key;

    updateBox(eles, color, opacity, box, label);

    label.onmousedown = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      let start = { x: ev.clientX, y: ev.clientY };
      const onMove = (mv) => {
        const dz = cy.zoom() || 1;
        const dx = (mv.clientX - start.x) / dz;
        const dy = (mv.clientY - start.y) / dz;
        start = { x: mv.clientX, y: mv.clientY };
        eles.forEach(n => {
          const p = n.position();
          n.position({ x: p.x + dx, y: p.y + dy });
        });
        updateBox(eles, color, opacity, box, label);
      };
      const onUp = async () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const payload = [];
        eles.forEach(n => {
          const pos = n.position();
          payload.push({ id: n.id(), position: { x: pos.x, y: pos.y } });
        });
        if (payload.length) {
          try {
            if (activeLayerId) await axios.post(`/api/layers/${activeLayerId}/positions`, payload);
            else await axios.post('/api/nodes/positions', payload);
          } catch {}
        }
        renderGroups();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };

    activeKeys.add(key);
  });

  groupDomCache.forEach((entry, key) => {
    if (!activeKeys.has(key)) {
      if (entry.box?.isConnected) entry.box.remove();
      if (entry.label?.isConnected) entry.label.remove();
      groupDomCache.delete(key);
    }
  });
}

function renderGroups() {
  const groups = Array.isArray(cachedGroups) ? cachedGroups : [];
  const container = document.getElementById('graph');
  if (!container || !cy) return;
  const ensureOverlaySvg = () => {
    if (groupOverlaySvg?.isConnected) return groupOverlaySvg;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('group-overlay');
    svg.setAttribute('aria-hidden', 'true');
    container.appendChild(svg);
    groupOverlaySvg = svg;
    return svg;
  };
  const svg = ensureOverlaySvg();
  svg.setAttribute('width', String(container.clientWidth || 0));
  svg.setAttribute('height', String(container.clientHeight || 0));
  svg.setAttribute('viewBox', `0 0 ${container.clientWidth || 0} ${container.clientHeight || 0}`);
  const hexToRgba = (hex, alpha) => {
    try {
      if (!hex) return `rgba(59,130,246,${alpha ?? 0.08})`;
      let h = hex.trim();
      if (h.startsWith('#')) h = h.slice(1);
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      const r = parseInt(h.slice(0,2), 16);
      const g = parseInt(h.slice(2,4), 16);
      const b = parseInt(h.slice(4,6), 16);
      const a = (typeof alpha === 'number' ? alpha : 0.08);
      return `rgba(${r},${g},${b},${a})`;
    } catch { return `rgba(59,130,246,${alpha ?? 0.08})`; }
  };
  const intersects = (a, b) => !!a && !!b && a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  const inflateRect = (bb, padX, padY = padX) => ({
    x1: bb.x1 - padX,
    y1: bb.y1 - padY,
    x2: bb.x2 + padX,
    y2: bb.y2 + padY,
  });
  const roundedRectPath = (bb, radius = 14) => {
    const w = Math.max(0, bb.x2 - bb.x1);
    const h = Math.max(0, bb.y2 - bb.y1);
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    return [
      `M ${bb.x1 + r} ${bb.y1}`,
      `H ${bb.x2 - r}`,
      `A ${r} ${r} 0 0 1 ${bb.x2} ${bb.y1 + r}`,
      `V ${bb.y2 - r}`,
      `A ${r} ${r} 0 0 1 ${bb.x2 - r} ${bb.y2}`,
      `H ${bb.x1 + r}`,
      `A ${r} ${r} 0 0 1 ${bb.x1} ${bb.y2 - r}`,
      `V ${bb.y1 + r}`,
      `A ${r} ${r} 0 0 1 ${bb.x1 + r} ${bb.y1}`,
      'Z',
    ].join(' ');
  };
  const updatePath = (group, els, memberIdSet, color, opacity, pathEl, labelEl) => {
    const outerPad = 30;
    const avoidPad = 18;
    const overlapTolerance = 12;
    const bb = inflateRect(els.renderedBoundingBox({ includeLabels: false, includeOverlays: false }), outerPad);
    const memberRects = [];
    els.forEach((node) => {
      memberRects.push(inflateRect(node.renderedBoundingBox({ includeLabels: false, includeOverlays: false }), 8));
    });
    const holes = [];
    let conflictCount = 0;
    cy.nodes().forEach((node) => {
      if (memberIdSet.has(node.id())) return;
      const nodeBb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
      if (!intersects(nodeBb, bb)) return;
      const overlapsMember = memberRects.some((rect) => intersects(rect, inflateRect(nodeBb, overlapTolerance)));
      if (overlapsMember) {
        conflictCount += 1;
        return;
      }
      const holeBb = inflateRect(nodeBb, avoidPad);
      holes.push(roundedRectPath(holeBb, Math.min(22, Math.max(12, Math.min(holeBb.x2 - holeBb.x1, holeBb.y2 - holeBb.y1) / 2))));
    });
    pathEl.setAttribute('d', [roundedRectPath(bb, 16), ...holes].join(' '));
    const fillOpacity = isDarkTheme() ? Math.max(opacity, 0.14) : opacity;
    pathEl.setAttribute('fill', hexToRgba(color, fillOpacity));
    pathEl.setAttribute('stroke', color);
    pathEl.setAttribute('stroke-width', '1.5');
    pathEl.setAttribute('fill-rule', 'evenodd');
    if (labelEl) {
      labelEl.style.left = `${bb.x1 + 8}px`;
      labelEl.style.top = `${bb.y1 + 4}px`;
      labelEl.textContent = conflictCount > 0 ? `${group.label || 'Group'} * ${conflictCount} overlap` : (group.label || 'Group');
    }
  };
  const membershipCount = new Map();
  groups.forEach((g) => {
    (g.members || []).filter(Boolean).forEach((id) => {
      membershipCount.set(id, (membershipCount.get(id) || 0) + 1);
    });
  });
  const activeKeys = new Set();
  groups.forEach((g) => {
    const ids = (g.members || []).filter(Boolean);
    const eles = cy.collection(ids.map(id => cy.getElementById(id))).filter('node');
    if (!eles || eles.length === 0) return;
    const color = g.color || '#3b82f6';
    const opacity = (typeof g.opacity === 'number') ? g.opacity : 0.08;
    const key = g.id != null ? String(g.id) : `__auto_${ids.slice().sort().join('|')}_${g.label || ''}`;
    const memberIdSet = new Set(ids);
    let entry = groupDomCache.get(key);
    if (!entry) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.classList.add('group-path');

      const lbl = document.createElement('div');
      lbl.className = 'group-label';
      lbl.style.position = 'absolute';
      lbl.style.padding = '2px 6px';
      const theme = themePalette();
      lbl.style.background = theme.groupLabelBg;
      lbl.style.border = `1px solid ${theme.groupLabelBorder}`;
      lbl.style.color = theme.groupLabelText;
      lbl.style.borderRadius = '6px';
      lbl.style.fontSize = '12px';
      lbl.style.cursor = 'move';
      lbl.style.zIndex = 3;

      entry = { path, label: lbl };
      groupDomCache.set(key, entry);
    }

    const { path, label } = entry;
    const currentTheme = themePalette();
    label.style.background = currentTheme.groupLabelBg;
    label.style.border = `1px solid ${currentTheme.groupLabelBorder}`;
    label.style.color = currentTheme.groupLabelText;
    if (!path.isConnected) svg.appendChild(path);
    if (!label.isConnected) container.appendChild(label);

    label.dataset.groupKey = key;
    updatePath(g, eles, memberIdSet, color, opacity, path, label);

    label.onmousedown = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      let start = { x: ev.clientX, y: ev.clientY };
      const onMove = (mv) => {
        const dz = cy.zoom() || 1;
        const dx = (mv.clientX - start.x) / dz;
        const dy = (mv.clientY - start.y) / dz;
        start = { x: mv.clientX, y: mv.clientY };
        eles.forEach(n => {
          const p = n.position();
          n.position({ x: p.x + dx, y: p.y + dy });
        });
        updatePath(g, eles, memberIdSet, color, opacity, path, label);
      };
      const onUp = async () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const payload = [];
        eles.forEach(n => {
          const pos = n.position();
          payload.push({ id: n.id(), position: { x: pos.x, y: pos.y } });
        });
        if (payload.length) {
          try {
            if (activeLayerId) await axios.post(`/api/layers/${activeLayerId}/positions`, payload);
            else await axios.post('/api/nodes/positions', payload);
          } catch {}
        }
        renderGroups();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };

    activeKeys.add(key);
  });

  groupDomCache.forEach((entry, key) => {
    if (!activeKeys.has(key)) {
      if (entry.path?.isConnected) entry.path.remove();
      if (entry.label?.isConnected) entry.label.remove();
      groupDomCache.delete(key);
    }
  });

  const activeBadgeIds = new Set();
  membershipCount.forEach((count, nodeId) => {
    if (count <= 1) return;
    const node = cy.getElementById(nodeId);
    if (!node || node.empty()) return;
    const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    let badge = groupBadgeCache.get(nodeId);
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'group-member-badge';
      container.appendChild(badge);
      groupBadgeCache.set(nodeId, badge);
    }
    badge.textContent = `x${count}`;
    badge.style.left = `${bb.x2 - 10}px`;
    badge.style.top = `${bb.y1 - 10}px`;
    activeBadgeIds.add(nodeId);
  });
  groupBadgeCache.forEach((badge, nodeId) => {
    if (!activeBadgeIds.has(nodeId)) {
      if (badge?.isConnected) badge.remove();
      groupBadgeCache.delete(nodeId);
    }
  });
  syncGroupOverlay();
}

async function refreshGroupsCache() {
  try {
    const { data } = await axios.get('/api/groups');
    cachedGroups = Array.isArray(data) ? data : [];
  } catch { cachedGroups = []; }
}

async function bootstrap() {
  applyTheme(isDarkTheme(), false);
  await initTemplates();
  await refresh();
  // 首次加载按当前画布尺寸把可见内容完整纳入视野，避免节点挤在角落
  if (cy) {
    cy.resize();
    const visible = cy.nodes().filter(n => n.style('display') !== 'none');
    if (visible.length) { try { cy.fit(visible, 60); } catch {} }
  }

  function setHelpOpen(open) {
    const panel = document.getElementById('help-panel');
    const toggleBtn = document.getElementById('btn-help-toggle');
    if (!panel) return;
    panel.classList.toggle('open', !!open);
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    try { localStorage.setItem('helpPanelOpen', open ? '1' : '0'); } catch {}
  }

  function toggleHelpPanel(forceOpen) {
    const panel = document.getElementById('help-panel');
    if (!panel) return;
    const next = typeof forceOpen === 'boolean' ? forceOpen : !panel.classList.contains('open');
    setHelpOpen(next);
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.dropdown.open').forEach(el => el.classList.remove('open'));
  }

  function clearSelectionAndFocus() {
    if (cy) cy.elements().unselect();
    selectedNode = null;
    focusNodeId = null;
    linkPick = [];
    const status = document.getElementById('link-status');
    if (status) status.textContent = '';
    const editor = document.getElementById('node-editor');
    if (editor) editor.innerHTML = '<div class="hint">选择图中的一个节点以编辑字段。</div>';
    updateFocusBySelection();
  }

  const btnHelpToggle = document.getElementById('btn-help-toggle');
  const btnHelpClose = document.getElementById('btn-help-close');
  if (btnHelpToggle && !btnHelpToggle.dataset.bound) {
    btnHelpToggle.dataset.bound = '1';
    btnHelpToggle.addEventListener('click', () => toggleHelpPanel());
  }
  if (btnHelpClose && !btnHelpClose.dataset.bound) {
    btnHelpClose.dataset.bound = '1';
    btnHelpClose.addEventListener('click', () => setHelpOpen(false));
  }
  try { setHelpOpen(localStorage.getItem('helpPanelOpen') === '1'); } catch { setHelpOpen(false); }

  document.getElementById('btn-new-node').onclick = async () => {
    const center = getViewportCenter();
    let fields = [];
    // 若开启“新建自动指向选中”，并且当前有选中节点，则注入一个字段
    const toggle = document.getElementById('auto-link-on-create');
    const enabled = !!(toggle && toggle.checked);
    const sel = cy ? cy.nodes(':selected') : null;
    if (enabled && sel && sel.length > 0) {
      const target = sel[0];
      const raw = getNodeById(target.id());
      if (raw) {
        // 取目标节点的第一个 tag 值作为键，名称/文本作为值
        const tagField = (raw.fields || []).find(f => f.type === 'tag' && f.value);
        const nameField = (raw.fields || []).find(f => f.key === '名称') || (raw.fields || []).find(f => f.type === 'text');
        const key = tagField ? String(tagField.value) : '标签';
        const val = nameField ? String(nameField.value || '') : (raw.id || '');
        fields.push({ key, type: 'text', value: val });
      }
    }
    const payload = center ? { fields, position: center } : { fields };
    if (activeLayerId) payload.layerId = activeLayerId;
    const { data } = await axios.post('/api/nodes', payload);
    await refresh();
    selectedNode = cy.getElementById(data.id);
    selectedNode.select();
    updateEditor(data.id);
  };

  document.getElementById('btn-apply-template').onclick = async () => {
    const tplSel = document.getElementById('template-select');
    const name = tplSel.value;
    if (!name) return;
  const tpls = JSON.parse(tplSel.dataset.templates || '{}');
  let fields = (tpls[name] || []).map(f => ({ ...f }));
  const center = getViewportCenter();
  // 同步“新建自动指向选中”逻辑
  const toggle = document.getElementById('auto-link-on-create');
  const enabled = !!(toggle && toggle.checked);
  const selNodes = cy ? cy.nodes(':selected') : null;
  if (enabled && selNodes && selNodes.length > 0) {
    const target = selNodes[0];
    const raw = getNodeById(target.id());
    if (raw) {
      const tagField = (raw.fields || []).find(f => f.type === 'tag' && f.value);
      const nameField = (raw.fields || []).find(f => f.key === '名称') || (raw.fields || []).find(f => f.type === 'text');
      const key = tagField ? String(tagField.value) : '标签';
      const val = nameField ? String(nameField.value || '') : (raw.id || '');
      fields = [{ key, type: 'text', value: val }, ...fields];
    }
  }
  const payload = center ? { fields, position: center } : { fields };
  if (activeLayerId) payload.layerId = activeLayerId;
  const { data } = await axios.post('/api/nodes', payload);
    await refresh();
    selectedNode = cy.getElementById(data.id);
    selectedNode.select();
    updateEditor(data.id);
  };
  const dupBtn = document.getElementById('btn-duplicate');
  if (dupBtn) dupBtn.onclick = async () => { await duplicateSelectedNode(); };

  // 新建画布：可选择先保存（导出 JSON）再清空
  const btnNewCanvas = document.getElementById('btn-new-canvas');
  if (btnNewCanvas && !btnNewCanvas.dataset.bound) {
    btnNewCanvas.dataset.bound = '1';
    btnNewCanvas.onclick = async () => {
      try {
        const wantSave = confirm('是否在清空前保存当前画布为 JSON?\n选择“确定”将下载 JSON，随后清空；选择“取消”则直接清空。');
        if (wantSave) {
          const { data } = await axios.get('/api/export/json');
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'backup.json'; a.click();
          URL.revokeObjectURL(url);
        }
        if (!confirm('此操作将清空当前画布的所有节点与手动关联，且无法撤销。是否继续？')) return;
        await axios.post('/api/reset');
        // 新建画布会清空全部图层，必须回到全局浏览
        activeLayerId = null;
        // 清理前端状态
        selectedNode = null;
        focusNodeId = null;
        lastTapNodeId = null;
        lastTapTime = 0;
        edgeCpd.clear();
        const editor = document.getElementById('node-editor');
        if (editor) editor.innerHTML = '<div class="hint">选择图中的一个节点以编辑字段。</div>';
        await refresh();
      } catch (e) {
        alert('新建画布失败');
      }
    };
  }

  // 绑定边文本显示开关
  const toggle = document.getElementById('toggle-edge-labels');
  if (toggle && !toggle.dataset.bound) {
    toggle.dataset.bound = '1';
    // 默认开启
    if (!('checked' in toggle)) toggle.checked = true;
    toggle.addEventListener('change', () => applyEdgeLabelVisibility(!!toggle.checked));
  }

  document.getElementById('btn-layout').onclick = () => {
    cy.one('layoutstop', () => { try { adjustEdgeCurvatures(); } catch {} });
    cy.layout({ name: 'dagre', nodeSep: 20, rankSep: 60 }).run();
  };

  function adjustEdgeCurvatures() {
    // group edges by unordered node pair to fan out
    const groups = new Map(); // key: a|b (sorted), value: Array<edge>
    cy.edges().forEach(e => {
      const s = e.data('source'); const t = e.data('target');
      if (!s || !t) return;
      const key = [s, t].sort().join('|');
      const arr = groups.get(key) || [];
      arr.push(e);
      groups.set(key, arr);
    });
    const BASE = 50; // px
    groups.forEach(arr => {
      // keep locked edges' cpd, assign to others a symmetric fan
      const unlocked = arr.filter(e => !e.data('cpdLocked'));
      if (!unlocked.length) return;
      const n = unlocked.length;
      const offsets = fanOffsets(n, BASE);
      unlocked.forEach((e, i) => {
        const v = offsets[i];
        e.data('cpd', v);
        edgeCpd.set(e.id(), v); // keep for session refreshes
      });
    });
  }

  // 顶部下拉菜单交互
  function bindDropdown(id) {
    const root = document.getElementById(id);
    if (!root) return;
    const trigger = root.querySelector('.menu-trigger');
    const open = () => { root.classList.add('open'); };
    const close = (e) => {
      if (!root.contains(e.target)) root.classList.remove('open');
    };
    if (trigger && !trigger.dataset.bound) {
      trigger.dataset.bound = '1';
      trigger.addEventListener('click', async (e) => {
        e.stopPropagation();
        const opening = !root.classList.contains('open');
        root.classList.toggle('open');
        // 当打开编组菜单时，拉取并填充编组列表
        if (opening && id === 'dd-group' && root.querySelector('.menu')?.dataset.enhanced !== '1') {
          try {
            const { data } = await axios.get('/api/groups');
            cachedGroups = Array.isArray(data) ? data : [];
            const menu = root.querySelector('.menu');
            let list = menu.querySelector('.group-list');
            if (!list) {
              list = document.createElement('div');
              list.className = 'group-list';
              list.style.maxHeight = '220px';
              list.style.overflow = 'auto';
              list.style.marginTop = '6px';
              list.style.borderTop = `1px solid ${themePalette().groupLabelBorder}`;
              list.style.paddingTop = '6px';
              menu.appendChild(list);
            }
            list.innerHTML = '';
            if (!cachedGroups.length) {
              list.textContent = '暂无编组';
            } else {
              cachedGroups.forEach(g => {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.justifyContent = 'space-between';
                row.style.gap = '6px';
                row.style.padding = '4px 0';
                const name = document.createElement('span');
                name.textContent = `${g.label || '编组'} (${g.id})`;
                name.style.flex = '1';
                const editBtn = document.createElement('button');
                editBtn.textContent = '设为当前编辑';
                editBtn.onclick = async () => {
                  // 使用当前选中作为新成员集并更新名称/样式输入框值
                  const sel = cy ? cy.nodes(':selected') : null;
                  const ids = sel ? sel.map(n => n.id()) : (g.members || []);
                  const newLabel = prompt('编组名称：', g.label || '编组') || g.label || '编组';
                  const color = (document.getElementById('group-color')?.value) || g.color || '#3b82f6';
                  const opacityVal = parseFloat(document.getElementById('group-opacity')?.value || String(g.opacity ?? '0.08')) || (g.opacity ?? 0.08);
                  await axios.put(`/api/groups/${g.id}`, { label: newLabel, members: ids, color, opacity: opacityVal });
                  await refreshGroupsCache();
                  renderGroups();
                };
                const delBtn = document.createElement('button');
                delBtn.textContent = '删除';
                delBtn.onclick = async () => {
                  if (!confirm(`确认删除编组：${g.label || g.id}？`)) return;
                  await axios.delete(`/api/groups/${g.id}`);
                  await refreshGroupsCache();
                  renderGroups();
                  // 重新填充列表
                  trigger.click(); trigger.click();
                };
                row.appendChild(name);
                row.appendChild(editBtn);
                row.appendChild(delBtn);
                list.appendChild(row);
              });
            }
          } catch {}
        }
      });
      document.addEventListener('click', close);
    }
  }
  bindDropdown('dd-auto');
  bindDropdown('dd-io');
  bindDropdown('dd-group');

  // 记忆“新建自动指向选中”开关（localStorage）
  const autoOnCreate = document.getElementById('auto-link-on-create');
  if (autoOnCreate && !autoOnCreate.dataset.bound) {
    autoOnCreate.dataset.bound = '1';
    const k = 'autoLinkOnCreate';
    try { autoOnCreate.checked = localStorage.getItem(k) === '1'; } catch {}
    autoOnCreate.addEventListener('change', () => {
      try { localStorage.setItem(k, autoOnCreate.checked ? '1' : '0'); } catch {}
    });
  }

  // 编组工具栏操作
  const btnGroupCreate = document.getElementById('btn-group-create');
  if (btnGroupCreate && !btnGroupCreate.dataset.bound) {
    btnGroupCreate.dataset.bound = '1';
    btnGroupCreate.onclick = async () => {
      const sel = cy ? cy.nodes(':selected') : null;
      const ids = sel ? sel.map(n => n.id()) : [];
      if (!ids.length) { alert('请先选择至少一个节点'); return; }
      const label = prompt('编组名称：', '编组') || '编组';
      const color = (document.getElementById('group-color')?.value) || '#3b82f6';
      const opacityVal = parseFloat(document.getElementById('group-opacity')?.value || '0.08') || 0.08;
      try {
        await axios.post('/api/groups', { label, members: ids, color, opacity: opacityVal });
        await refreshGroupsCache();
        renderGroups();
      } catch { alert('创建失败'); }
    };
  }

  const btnGroupEdit = document.getElementById('btn-group-edit');
  if (btnGroupEdit && !btnGroupEdit.dataset.bound) {
    btnGroupEdit.dataset.bound = '1';
    btnGroupEdit.onclick = async () => {
      try {
        const { data } = await axios.get('/api/groups');
        const groups = Array.isArray(data) ? data : [];
        if (!groups.length) { alert('暂无编组'); return; }
        const gid = prompt('输入要编辑的编组ID：\n' + groups.map(g => `${g.id}: ${g.label}`).join('\n'));
        if (!gid) return;
        const g = groups.find(x => x.id === gid);
        if (!g) { alert('未找到该编组'); return; }
        // 使用当前选中作为新成员集
        const sel = cy ? cy.nodes(':selected') : null;
        const ids = sel ? sel.map(n => n.id()) : (g.members || []);
        const label = prompt('编组名称：', g.label || '编组') || g.label || '编组';
        const color = (document.getElementById('group-color')?.value) || g.color || '#3b82f6';
        const opacityVal = parseFloat(document.getElementById('group-opacity')?.value || String(g.opacity ?? '0.08')) || (g.opacity ?? 0.08);
  await axios.put(`/api/groups/${gid}`, { label, members: ids, color, opacity: opacityVal });
  await refreshGroupsCache();
  renderGroups();
      } catch { alert('编辑失败'); }
    };
  }

  const btnGroupDelete = document.getElementById('btn-group-delete');
  if (btnGroupDelete && !btnGroupDelete.dataset.bound) {
    btnGroupDelete.dataset.bound = '1';
    btnGroupDelete.onclick = async () => {
      try {
        const { data } = await axios.get('/api/groups');
        const groups = Array.isArray(data) ? data : [];
        if (!groups.length) { alert('暂无编组'); return; }
        const gid = prompt('输入要删除的编组ID：\n' + groups.map(g => `${g.id}: ${g.label}`).join('\n'));
        if (!gid) return;
        if (!confirm('确认删除该编组？')) return;
  await axios.delete(`/api/groups/${gid}`);
  await refreshGroupsCache();
  renderGroups();
      } catch { alert('删除失败'); }
    };
  }

  let currentGroupId = null;
  const getSelectedNodeIds = () => {
    const sel = cy ? cy.nodes(':selected') : null;
    return sel ? sel.map(n => n.id()) : [];
  };
  const getNodeDisplayName = (id) => {
    const raw = getNodeById(id);
    if (!raw) return id;
    const fields = raw.fields || [];
    const nameField = fields.find(f => f.key === '名称') || fields.find(f => f.type === 'text');
    const label = nameField ? String(nameField.value || '').trim() : '';
    return label || id;
  };
  const getCurrentGroup = () => cachedGroups.find(g => g.id === currentGroupId) || null;
  const setGroupStatus = (text = '') => {
    const el = document.getElementById('group-manager-status');
    if (el) el.textContent = text;
  };
  const renderGroupManager = () => {
    const listEl = document.getElementById('group-manager-list');
    const current = getCurrentGroup();
    const nameEl = document.getElementById('group-name');
    const colorEl = document.getElementById('group-color');
    const opacityEl = document.getElementById('group-opacity');
    const membersEl = document.getElementById('group-members');
    if (!listEl || !nameEl || !colorEl || !opacityEl || !membersEl) return;
    listEl.innerHTML = '';
    if (!cachedGroups.length) {
      listEl.innerHTML = '<div class="group-list-empty">No groups yet</div>';
    } else {
      cachedGroups.forEach((g) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `group-list-row${g.id === currentGroupId ? ' active' : ''}`;
        row.innerHTML = `<span>${g.label || 'Group'}</span><span class="muted">${(g.members || []).length}</span>`;
        row.onclick = () => {
          currentGroupId = g.id;
          setGroupStatus('');
          renderGroupManager();
        };
        listEl.appendChild(row);
      });
    }
    if (!current) {
      nameEl.value = '';
      colorEl.value = '#3b82f6';
      opacityEl.value = '0.08';
      membersEl.innerHTML = '<div class="group-list-empty">Select nodes and create a group.</div>';
      return;
    }
    nameEl.value = current.label || '';
    colorEl.value = current.color || '#3b82f6';
    opacityEl.value = String(typeof current.opacity === 'number' ? current.opacity : 0.08);
    membersEl.innerHTML = '';
    (current.members || []).forEach((id) => {
      const chip = document.createElement('div');
      chip.className = 'group-member-chip';
      chip.innerHTML = `<span>${getNodeDisplayName(id)}</span>`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = 'x';
      removeBtn.onclick = async () => {
        await axios.put(`/api/groups/${current.id}`, { members: (current.members || []).filter(x => x !== id) });
        await refreshGroupsCache();
        renderGroups();
        renderGroupManager();
        setGroupStatus(`Removed ${getNodeDisplayName(id)}`);
      };
      chip.appendChild(removeBtn);
      membersEl.appendChild(chip);
    });
    if (!(current.members || []).length) {
      membersEl.innerHTML = '<div class="group-list-empty">No members</div>';
    }
  };
  const openGroupManager = async () => {
    await refreshGroupsCache();
    if (!currentGroupId || !getCurrentGroup()) currentGroupId = cachedGroups[0]?.id || null;
    renderGroupManager();
  };

  // 从编组导入到图层窗：按编组成员/位置刷新已关联图层，并为缺失的编组补建图层。
  // 用于修复旧数据中「编组有成员、图层却是空壳」的问题。
  const importGroupsToLayers = async () => {
    await refreshGroupsCache();
    if (!cachedGroups.length) {
      alert('当前没有编组，无法导入图层窗。');
      return;
    }
    const total = cachedGroups.reduce((sum, g) => sum + ((g.members || []).length), 0);
    if (!confirm(`把当前 ${cachedGroups.length} 个编组（共 ${total} 个成员）导入到图层窗？\n\n· 已关联的图层会按编组刷新成员与位置（保留原文件夹归类）\n· 尚未关联图层窗的编组会自动补建图层\n· 手动新建的图层与文件夹不会被动到`)) return;
    try {
      const { data } = await axios.post('/api/layers/import-from-groups');
      await refreshLayersCache();
      renderLayerPanel();
      // 当前停留在某个图层时，重新载入画布以显示刚导入的成员
      if (activeLayerId) await refresh(false);
      setGroupStatus(`已导入：新建 ${data.created} 个图层，刷新 ${data.refreshed} 个图层，共 ${data.members} 个成员`);
    } catch {
      alert('导入图层窗失败');
    }
  };

  const setupGroupManager = () => {
    const root = document.getElementById('dd-group');
    const menu = root ? root.querySelector('.menu') : null;
    const trigger = root ? root.querySelector('.menu-trigger') : null;
    if (!menu || !trigger || menu.dataset.enhanced === '1') return;
    menu.dataset.enhanced = '1';
    menu.innerHTML = `
      <div class="group-manager">
        <div class="group-manager-head">
          <button id="btn-group-create">以备选节点创建</button>
          <button id="btn-group-save">保存编组</button>
          <button id="btn-group-delete">删除编组</button>
          <button id="btn-group-import-layers" class="group-import-btn" title="把当前所有编组的成员与位置同步进右下角图层窗">导入图层窗</button>
        </div>
        <div class="group-manager-body">
          <div class="group-manager-list-wrap">
            <div id="group-manager-list" class="group-manager-list"></div>
          </div>
          <div class="group-manager-editor">
            <div class="group-form-row">
              <label for="group-name">名称</label>
              <input id="group-name" type="text" placeholder="Group name" />
            </div>
            <div class="group-form-row">
              <label for="group-color">颜色</label>
              <input id="group-color" type="color" value="#3b82f6" />
            </div>
            <div class="group-form-row">
              <label for="group-opacity">不透明度</label>
              <input id="group-opacity" type="number" step="0.02" min="0" max="1" value="0.08" />
            </div>
            <div class="group-actions-row">
              <button id="btn-group-add-selected">添加选中节点</button>
              <button id="btn-group-remove-selected">移除选中节点</button>
            </div>
            <div class="group-members-panel">
              <div class="muted">成员节点</div>
              <div id="group-members" class="group-members"></div>
            </div>
            <div id="group-manager-status" class="muted"></div>
          </div>
        </div>
      </div>
    `;
    menu.addEventListener('click', async (ev) => {
      const target = ev.target.closest('button');
      if (!target) return;
      if (target.id === 'btn-group-create') {
        const ids = getSelectedNodeIds();
        if (!ids.length) { alert('Please select at least one node first.'); return; }
        const label = (document.getElementById('group-name')?.value || '').trim() || `Group ${cachedGroups.length + 1}`;
        const color = (document.getElementById('group-color')?.value) || '#3b82f6';
        const opacityVal = parseFloat(document.getElementById('group-opacity')?.value || '0.08') || 0.08;
        const { data } = await axios.post('/api/groups', { label, members: ids, color, opacity: opacityVal });
        currentGroupId = data.id;
        await openGroupManager();
        renderGroups();
        setGroupStatus(`Created ${label}`);
      } else if (target.id === 'btn-group-save') {
        const current = getCurrentGroup();
        if (!current) return;
        const label = (document.getElementById('group-name')?.value || '').trim() || current.label || 'Group';
        const color = (document.getElementById('group-color')?.value) || current.color || '#3b82f6';
        const rawOpacity = parseFloat(document.getElementById('group-opacity')?.value || String(current.opacity ?? '0.08'));
        const opacityVal = Number.isFinite(rawOpacity) ? Math.max(0, Math.min(1, rawOpacity)) : (current.opacity ?? 0.08);
        await axios.put(`/api/groups/${current.id}`, { label, color, opacity: opacityVal, members: current.members || [] });
        await openGroupManager();
        renderGroups();
        setGroupStatus(`Saved ${label}`);
      } else if (target.id === 'btn-group-delete') {
        const current = getCurrentGroup();
        if (!current) return;
        if (!confirm(`Delete group "${current.label || current.id}"?`)) return;
        await axios.delete(`/api/groups/${current.id}`);
        currentGroupId = null;
        await openGroupManager();
        renderGroups();
        setGroupStatus('Group deleted');
      } else if (target.id === 'btn-group-add-selected') {
        const current = getCurrentGroup();
        if (!current) return;
        const ids = getSelectedNodeIds();
        if (!ids.length) { alert('Please select nodes to add.'); return; }
        await axios.put(`/api/groups/${current.id}`, { members: Array.from(new Set([...(current.members || []), ...ids])) });
        await openGroupManager();
        renderGroups();
        setGroupStatus(`Added ${ids.length} node(s)`);
      } else if (target.id === 'btn-group-remove-selected') {
        const current = getCurrentGroup();
        if (!current) return;
        const selected = new Set(getSelectedNodeIds());
        if (!selected.size) { alert('Please select nodes to remove.'); return; }
        await axios.put(`/api/groups/${current.id}`, { members: (current.members || []).filter(id => !selected.has(id)) });
        await openGroupManager();
        renderGroups();
        setGroupStatus(`Removed ${selected.size} node(s)`);
      } else if (target.id === 'btn-group-import-layers') {
        await importGroupsToLayers();
      }
    });
    trigger.addEventListener('click', () => { setTimeout(() => { if (root.classList.contains('open')) openGroupManager(); }, 0); });
  };
  setupGroupManager();

  function fanOffsets(n, base) {
    if (n <= 0) return [];
    if (n === 1) return [0];
    const out = [];
    const step = base;
    // generate symmetrical sequence around 0 without duplicates, e.g., -50,50,-100,100,...
    let k = 1;
    while (out.length < n) {
      out.push(-k * step);
      if (out.length >= n) break;
      out.push(k * step);
      k += 1;
    }
    // If odd count, prepend 0 to center
    if (n % 2 === 1) {
      out.unshift(0);
      out.pop(); // keep length n
    }
    return out;
  }

  // 绑定自动关联筛选控件
  const presetSel = document.getElementById('auto-filter-preset');
  if (presetSel && !presetSel.dataset.bound) {
    presetSel.dataset.bound = '1';
    presetSel.addEventListener('change', () => { applyAutoEdgeFilter(); updateFocusBySelection(); });
  }
  const exprInput = document.getElementById('auto-filter');
  if (exprInput && !exprInput.dataset.bound) {
    exprInput.dataset.bound = '1';
    exprInput.addEventListener('input', () => { applyAutoEdgeFilter(); updateFocusBySelection(); });
  }
  // 聚焦层数输入变更
  const depthInput = document.getElementById('focus-depth');
  if (depthInput && !depthInput.dataset.bound) {
    depthInput.dataset.bound = '1';
    depthInput.addEventListener('change', () => {
      // 合法化
      const v = Math.max(1, parseInt(depthInput.value || '1', 10) || 1);
      depthInput.value = String(v);
      updateFocusBySelection();
    });
  }

  // 撤销/重做按钮
  document.getElementById('btn-undo').onclick = async () => {
    try { await axios.post('/api/undo'); } finally { await refresh(false); }
  };
  document.getElementById('btn-redo').onclick = async () => {
    try { await axios.post('/api/redo'); } finally { await refresh(false); }
  };
  setupThemeToggle();

  // 快捷键：Ctrl+Z / Ctrl+Y 及其他
  window.addEventListener('keydown', async (ev) => {
    const ctrl = ev.ctrlKey || ev.metaKey; // 兼容 mac
    if (!ctrl) return;
    // 避免在输入框中触发
    const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || ev.target?.isContentEditable) return;
  if (ev.key.toLowerCase() === 'z') { ev.preventDefault(); await axios.post('/api/undo'); await refresh(false); }
  else if (ev.key.toLowerCase() === 'y') { ev.preventDefault(); await axios.post('/api/redo'); await refresh(false); }
    // 复制节点：Ctrl+Shift+K（避免与浏览器快捷键冲突）
    else if (ev.shiftKey && ev.key.toLowerCase() === 'k') { ev.preventDefault(); await duplicateSelectedNode(); }
    // 搜索框聚焦：Ctrl+F
    else if (ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      const s = document.getElementById('search');
      if (s) { s.focus(); s.select?.(); }
    }
    // 导出 JSON：Ctrl+S
    else if (ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      const btn = document.getElementById('btn-export');
      if (btn) btn.click();
    }
  });

  // 无修饰快捷键：避免在输入框中触发
  window.addEventListener('keydown', async (ev) => {
    const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || ev.target?.isContentEditable) return;
    const key = ev.key.toLowerCase();
    // 关闭操作：Esc
    if (key === 'escape') {
      ev.preventDefault();
      closeAllDropdowns();
      setHelpOpen(false);
      clearSelectionAndFocus();
      return;
    }
    // 新建节点：N
    if (key === 'n') { ev.preventDefault(); const btn = document.getElementById('btn-new-node'); if (btn) btn.click(); }
    // 开始连线：L 或 A
    else if (key === 'l' || key === 'a') { ev.preventDefault(); const btn = document.getElementById('btn-start-link'); if (btn) btn.click(); }
    // 为选中节点添加字段：F
    else if (key === 'f') { ev.preventDefault(); const b = document.querySelector('#node-editor #add-field'); if (b) b.click(); }
    // 快速聚焦搜索：/
    else if (key === '/') { ev.preventDefault(); const s = document.getElementById('search'); if (s) { s.focus(); s.select?.(); } }
    // 新建编组：G（基于当前选中）
    else if (key === 'g') { ev.preventDefault(); const btn = document.getElementById('btn-group-create'); if (btn) btn.click(); }
    // 帮助面板开关：H / ?
    else if (key === 'h' || ev.key === '?' || (ev.key === '/' && ev.shiftKey)) { ev.preventDefault(); toggleHelpPanel(); }
    // 删除选中：Delete / Backspace
    else if (key === 'delete' || key === 'backspace') { ev.preventDefault(); await deleteSelection(); }
  });

  async function duplicateSelectedNode() {
    const sel = cy ? cy.nodes(':selected') : null;
    if (!sel || sel.length === 0) return;
    const node = sel[0];
    const id = node.id();
    const raw = getNodeById(id);
    if (!raw) return;
    // 深拷贝字段
    const fields = (raw.fields || []).map(f => ({ key: f.key, type: f.type, value: f.value }));
    const pos = node.position();
    const payload = { fields, position: { x: pos.x + 40, y: pos.y + 40 } };
    if (activeLayerId) payload.layerId = activeLayerId;
    const { data } = await axios.post('/api/nodes', payload);
    await refresh();
    const newNode = cy.getElementById(data.id);
    if (newNode && newNode.nonempty()) { newNode.select(); updateEditor(data.id); }
  }
  window.duplicateSelectedNode = duplicateSelectedNode;

  async function deleteSelection() {
    const sels = cy ? cy.elements(':selected') : null;
    if (!sels || sels.length === 0) return;
    // 优先删除边，再删节点
    const edges = sels.filter('edge');
    const nodes = sels.filter('node');
    // 删除边
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (e.hasClass('manual')) {
        try { await axios.delete(`/api/links/${e.id()}`); } catch {}
      } else if (e.hasClass('auto')) {
        try { await axios.post('/api/auto/suppress', { a: e.data('source'), b: e.data('target') }); } catch {}
      }
    }
    // 删除节点（会级联移除相关手动边）
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      try { await axios.delete(`/api/nodes/${n.id()}`); } catch {}
    }
    await refresh();
  }

  document.getElementById('search').oninput = () => { applyViewFilter(); };

  document.getElementById('btn-start-link').onclick = () => {
    linkPick = [];
    document.getElementById('link-status').textContent = '请点击选择第一个节点…';
    cy.one('tap', 'node', evt => {
      linkPick = [evt.target.id()];
      document.getElementById('link-status').textContent = '已选第一个节点，请选择第二个节点…';
    });
  };

  // 手动连线删除绑定已在 renderGraph 中设置

  document.getElementById('btn-export').onclick = async () => {
    const { data } = await axios.get('/api/export/json');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'export.json'; a.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById('btn-export-csv').onclick = async () => {
    const res = await fetch('/api/export/csv');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'export.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById('btn-export-md').onclick = async () => {
    const res = await fetch('/api/export/md');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'export.md'; a.click();
    URL.revokeObjectURL(url);
  };

  // 导出 PNG（鲁棒版）：先全图 Blob，失败则降低 scale；再降级 base64；最后仅导出视窗
  const btnPng = document.getElementById('btn-export-png');
  if (btnPng && !btnPng.dataset.bound) {
    btnPng.dataset.bound = '1';
    btnPng.onclick = async () => {
      if (!cy) return;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const fname = `graph-${ts}.png`;
      const makeDownload = (href) => { const a = document.createElement('a'); a.href = href; a.download = fname; a.click(); };
      const scales = [2, 1.5, 1, 0.75, 0.5, 0.35, 0.25];
      // 1) 全图 Blob，递减 scale
      for (const s of scales) {
        try {
          const blob = await cy.png({ output: 'blob', full: true, scale: s, bg: exportBg() });
          if (blob && blob.size > 0) { const url = URL.createObjectURL(blob); makeDownload(url); setTimeout(()=>URL.revokeObjectURL(url),1500); return; }
        } catch {}
      }
      // 2) 全图 base64，递减 scale
      for (const s of scales) {
        try {
          const data = cy.png({ output: 'base64uri', full: true, scale: s, bg: exportBg() });
          if (data && typeof data === 'string' && data.startsWith('data:image/png')) { makeDownload(data); return; }
        } catch {}
      }
      // 3) 仅视窗 Blob/base64
      try {
        const blob = await cy.png({ output: 'blob', full: false, scale: 2, bg: exportBg() });
        const url = URL.createObjectURL(blob); makeDownload(url); setTimeout(()=>URL.revokeObjectURL(url),1500); return;
      } catch {}
      try {
        const data = cy.png({ output: 'base64uri', full: false, scale: 2, bg: exportBg() });
        makeDownload(data); return;
      } catch {}
      alert('导出 PNG 失败：图像过大或内存不足，请缩小范围或降低清晰度重试。');
    };
  }

  document.getElementById('import-json').onchange = async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const obj = JSON.parse(text);
    await axios.post('/api/import/json', obj);
    // 导入会整体替换图层；当前激活图层若已不在新数据中则回到全局浏览，
    // 否则 loadData() 会带着失效的 layer id 请求，导致画布与小窗状态不一致。
    try {
      const { data: layers } = await axios.get('/api/layers');
      if (activeLayerId && !(layers || []).some(l => l && l.id === activeLayerId)) activeLayerId = null;
    } catch {}
    await refresh();
  };

  document.getElementById('import-csv').onchange = async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await fetch('/api/import/csv', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text });
    await refresh();
  };

  // 左侧编辑栏拖拽调整宽度
  const resizer = document.getElementById('resizer');
  const main = document.querySelector('main');
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    sidebarWidth = Math.max(220, Math.min(600, e.clientX));
    main.style.gridTemplateColumns = `${sidebarWidth}px 6px 1fr`;
    scheduleGraphResize();
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('resize', scheduleGraphResize);
  // 初始化一次，确保与 CSS 一致
  main.style.gridTemplateColumns = `${sidebarWidth}px 6px 1fr`;
}

window.addEventListener('DOMContentLoaded', bootstrap);

function getViewportCenter() {
  if (!cy) return null;
  try {
    const pan = cy.pan();
    const zoom = cy.zoom() || 1;
    const w = cy.width();
    const h = cy.height();
    const rx = w / 2;
    const ry = h / 2;
    return { x: (rx - pan.x) / zoom, y: (ry - pan.y) / zoom };
  } catch { return null; }
}

function updateFocusBySelection() {
  if (!cy) return;
  cy.batch(() => {
    // 先清除淡化
  cy.nodes().removeClass('faded').selectify().grabify();
  cy.edges().removeClass('faded');
    // 未处于聚焦模式，直接返回
    if (!focusNodeId) return;
    const node = cy.getElementById(focusNodeId);
    if (!node || node.empty() || node.style('display') === 'none') {
      // 聚焦节点不存在或被隐藏，则退出聚焦模式
      focusNodeId = null;
      return;
    }
    // 读取层数（默认 1 层），进行按层 BFS，遵循当前显示状态
    const inp = document.getElementById('focus-depth');
    const depth = Math.max(1, parseInt(inp?.value || '1', 10) || 1);

    const visibleNodes = new Set();
    cy.nodes().forEach(n => { if (n.style('display') !== 'none') visibleNodes.add(n.id()); });
    const visibleEdges = cy.edges().filter(e => e.style('display') !== 'none');

    const adjacency = new Map();
    visibleEdges.forEach(e => {
      const s = e.data('source');
      const t = e.data('target');
      if (!visibleNodes.has(s) || !visibleNodes.has(t)) return;
      const edgeId = e.id();
      if (!adjacency.has(s)) adjacency.set(s, []);
      if (!adjacency.has(t)) adjacency.set(t, []);
      adjacency.get(s).push({ node: t, edgeId });
      adjacency.get(t).push({ node: s, edgeId });
    });

    const queue = [{ id: node.id(), d: 0 }];
    const seen = new Set([node.id()]);
    const keepNodes = new Set([node.id()]);
    const keepEdges = new Set();

    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      if (cur.d >= depth) continue;
      const neighbors = adjacency.get(cur.id);
      if (!neighbors) continue;
      for (let j = 0; j < neighbors.length; j++) {
        const { node: other, edgeId } = neighbors[j];
        keepEdges.add(edgeId);
        keepNodes.add(other);
        if (!seen.has(other)) {
          seen.add(other);
          queue.push({ id: other, d: cur.d + 1 });
        }
      }
    }

    // 应用淡化：仅保留 keepNodes 与 keepEdges；被淡化的节点禁止选中/拖拽
    cy.nodes().forEach(n => {
      if (!keepNodes.has(n.id())) { n.addClass('faded'); n.unselect(); n.ungrabify(); n.unselectify(); }
    });
    cy.edges().forEach(e => { if (!keepEdges.has(e.id())) e.addClass('faded'); });
  });
}

function applyAutoEdgeFilter() {
  if (!cy) return;
  const preset = document.getElementById('auto-filter-preset');
  const exprEl = document.getElementById('auto-filter');
  const presetVal = preset ? (preset.value || 'all') : 'all';
  let expr = (exprEl && exprEl.value) ? String(exprEl.value).trim() : '';
  // 解析表达式：支持 OR/或/|| 联合；AND/与/&& 简化为联合（对单条边无意义）
  expr = expr
    .replaceAll('||', ' OR ')
    .replaceAll('或', ' OR ')
    .replaceAll('与', ' OR ')
    .replaceAll('&&', ' OR ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = expr ? expr.split(/\sOR\s/i).map(s => s.trim()).filter(Boolean) : [];

  cy.batch(() => {
    cy.edges().forEach(e => {
      if (!e.hasClass('auto')) return; // 只处理自动连线
      let visible = true;
      if (presetVal === 'none') {
        visible = false;
      } else if (tokens.length > 0) {
        // 从边的 label 或边上派生的标签里匹配关键字
        const label = String(e.data('label') || '');
        // 边的标签来源：我们使用 Rule B，通常 label 是 "B" 或字段名；这里仅作关键词包含判断
        const hay = label;
        visible = tokens.some(t => hay.includes(t));
      } else {
        // all
        visible = true;
      }
      e.style('display', visible ? 'element' : 'none');
    });
  });
}

function applyEdgeLabelVisibility(show) {
  if (!cy) return;
  cy.batch(() => {
    cy.edges().forEach(e => {
      if (show) {
        e.style('label', e.data('label') || '');
        e.style('text-opacity', 1);
      } else {
        e.style('label', '');
        e.style('text-opacity', 0);
      }
    });
  });
}

async function renderSuppressed() {
  const box = document.getElementById('suppressed-list');
  try {
    const { data } = await axios.get('/api/auto/suppressed');
    const list = Array.isArray(data) ? data : [];
    if (!list.length) { box.textContent = '无'; return; }
    box.innerHTML = '';
    const raws = Array.isArray(window.__rawNodes) ? window.__rawNodes : [];
    const byId = new Map(raws.map(n => [n.id, n]));
    const disp = (id) => {
      const n = byId.get(id);
      if (!n) return id;
      const fields = n.fields || [];
      const f = fields.find(x => x.key === '名称') || fields.find(x => x.type === 'text');
      const name = (f && String(f.value || '').trim()) || '';
      return name && name !== id ? `${name} (${id})` : id;
    };
    list.forEach(p => {
      const a = document.createElement('div');
      a.className = 'supp-item';
      const t = document.createElement('span');
      t.textContent = `${disp(p.a)} ⇄ ${disp(p.b)}`;
      const btn = document.createElement('button');
      btn.textContent = '恢复';
      btn.onclick = async () => { await axios.post('/api/auto/unsuppress', { a: p.a, b: p.b }); await refresh(); };
      a.appendChild(t); a.appendChild(btn);
      box.appendChild(a);
    });
  } catch (e) {
    box.textContent = '加载失败';
  }
}

async function updateHistoryButtons() {
  try {
    const { data } = await axios.get('/api/history');
    const u = document.getElementById('btn-undo');
    const r = document.getElementById('btn-redo');
    if (u) u.disabled = !data.canUndo;
    if (r) r.disabled = !data.canRedo;
  } catch {}
}
