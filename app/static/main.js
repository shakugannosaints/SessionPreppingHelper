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
// debounced saver for node positions after drag
let dragSaveTimer = null;
let dragSaveIds = new Set();
// 聚焦模式状态：仅当双击同一节点后才进入
let focusNodeId = null;
let lastTapNodeId = null;
let lastTapTime = 0;
const DOUBLE_TAP_MS = 350;

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
  const selColor = invertHex(baseColor);
  return {
    data: { id: n.id, label, selColor },
    position: n.position || undefined,
    style: {
      'background-color': baseColor,
      'width': size,
      'height': size,
      'label': label,
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': Math.max(6, 12 * scale),
      'color': '#111',
      'text-outline-color': '#fff',
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
  // 总是获取完整数据，自动连线筛选在前端完成
  const { data } = await axios.get('/api/data');
  const nodes = (data.nodes || []).map(mapNode);
  const edges = [...(data.links || []), ...(data.autoLinks || [])].map(mapLink);
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
  // Preserve viewport (pan/zoom) across re-renders
  const prev = cy ? { pan: cy.pan(), zoom: cy.zoom() } : null;
  cy = cytoscape({
    container: el,
    elements: { nodes, edges },
    layout: { name: 'preset' },
  boxSelectionEnabled: true,
  wheelSensitivity: 0.15,
  minZoom: 0.02,
  maxZoom: 4,
  style: [
  { selector: 'node', style: { 'background-color': '#9CA3AF', 'border-width': 2, 'border-color': '#fff' } },
  { selector: 'node:selected', style: { 'border-color': 'data(selColor)', 'border-width': 4, 'shadow-blur': 12, 'shadow-color': 'data(selColor)', 'shadow-opacity': 0.8, 'shadow-offset-x': 0, 'shadow-offset-y': 0 } },
  { selector: 'edge', style: { 'curve-style': 'unbundled-bezier', 'edge-distances': 'node-position', 'line-color': '#CBD5E1', 'width': 2, 'label': 'data(label)', 'font-size': 10, 'text-background-opacity': 1, 'text-background-color': '#fff', 'text-background-padding': 2, 'target-arrow-shape': 'triangle', 'target-arrow-color': '#CBD5E1', 'control-point-distance': 'data(cpd)', 'control-point-weight': 0.5, 'text-rotation': 'autorotate' } },
  // 聚焦模式：非邻域淡化
  { selector: 'node.faded', style: { 'opacity': 0.15, 'text-opacity': 0.2, 'events': 'no' } },
  { selector: 'edge.faded', style: { 'opacity': 0.12, 'text-opacity': 0.0, 'events': 'no' } },
  // 根据弧度方向微调文本，向上弯时上移 6px，向下弯时下移 6px
  { selector: 'edge[cpd > 0]', style: { 'text-margin-y': -6 } },
  { selector: 'edge[cpd < 0]', style: { 'text-margin-y': 6 } },
  { selector: 'edge.dual', style: { 'source-arrow-shape': 'triangle', 'source-arrow-color': '#CBD5E1' } },
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
        if (payload.length) await axios.post('/api/nodes/positions', payload);
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
      <div style="margin:8px 0;">
        <button id="add-field">+ 添加字段</button>
        <button id="save-fields">保存</button>
      </div>
      <button id="delete-node" style="color:#b91c1c">删除该节点</button>
    </div>
  `;
}

function attr(name, value) { return value != null ? `${name}="${String(value).replaceAll('"','&quot;')}"` : ''; }
function opt(v, cur) { return `<option value="${v}" ${v===cur?'selected':''}>${v}</option>` }

function getNodeById(id) { return (window.__rawNodes || []).find(n => n.id === id); }

function updateEditor(id) {
  const node = getNodeById(id);
  const el = document.getElementById('node-editor');
  if (!node) { el.innerHTML = '<div class="hint">未找到节点。</div>'; return; }
  el.innerHTML = editorHtml(node);
  el.querySelector('#add-field').onclick = () => {
    // 读取当前输入，避免内容丢失
    const rows = [...el.querySelectorAll('.field-row')];
    node.fields = rows.filter(r => r.querySelector('[data-k]')).map(r => ({
      key: r.querySelector('[data-k]').value,
      type: r.querySelector('[data-t]').value,
      value: r.querySelector('[data-v]').value,
    }));
    // 同步大小倍率到字段集中
    const scaleInput = el.querySelector('#size-scale');
    if (scaleInput) {
      const sc = Math.max(0.5, parseFloat(scaleInput.value || '1') || 1);
      const idx = node.fields.findIndex(f => String(f.key) === '大小倍率');
      if (idx >= 0) node.fields[idx] = { key: '大小倍率', type: 'number', value: String(sc) };
      else node.fields.unshift({ key: '大小倍率', type: 'number', value: String(sc) });
    }
    const zOrderInput = el.querySelector('#node-z-order');
    if (zOrderInput) {
      const z = Math.round(parseFloat(zOrderInput.value || '0') || 0);
      const idx = node.fields.findIndex(f => String(f.key) === '覆盖顺序');
      if (idx >= 0) node.fields[idx] = { key: '覆盖顺序', type: 'number', value: String(z) };
      else node.fields.unshift({ key: '覆盖顺序', type: 'number', value: String(z) });
    }
    node.fields.push({ key: '', type: 'text', value: '' });
    updateEditor(id);
  };
  el.querySelector('#save-fields').onclick = async () => {
    const rows = [...el.querySelectorAll('.field-row')];
    const list = rows.filter(r => r.querySelector('[data-k]')).map(r => ({
      key: r.querySelector('[data-k]').value.trim(),
      type: r.querySelector('[data-t]').value,
      value: r.querySelector('[data-v]').value,
    })).filter(f => f.key);
    // 读取并合并大小倍率
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
    await axios.put(`/api/nodes/${id}`, { fields: list });
    await refresh();
    selectedNode = cy.getElementById(id);
    selectedNode ? selectedNode.select() : null;
    updateEditor(id);
  };

  // 自动高度：对所有 textarea 进行自适应
  el.querySelectorAll('textarea[data-v]').forEach(t => {
    const auto = () => { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; };
    t.addEventListener('input', auto);
    auto();
  });
  el.querySelector('#delete-node').onclick = async () => {
    if (!confirm('确认删除该节点？')) return;
    await axios.delete(`/api/nodes/${id}`);
    selectedNode = null;
    document.getElementById('node-editor').innerHTML = '<div class="hint">选择图中的一个节点以编辑字段。</div>';
    await refresh();
  }
  el.querySelectorAll('[data-del]').forEach((btn, idx) => btn.onclick = () => {
    // 删除前先取当前所有值，避免丢失未保存的编辑内容
    const rows = [...el.querySelectorAll('.field-row')];
    const list = rows.filter(r => r.querySelector('[data-k]')).map(r => ({
      key: r.querySelector('[data-k]').value,
      type: r.querySelector('[data-t]').value,
      value: r.querySelector('[data-v]').value,
    }));
    // 先删除可编辑字段中的目标项
    list.splice(idx, 1);
    // 同步大小倍率
    const scaleInput = el.querySelector('#size-scale');
    if (scaleInput) {
      const sc = Math.max(0.5, parseFloat(scaleInput.value || '1') || 1);
      const idxx = list.findIndex(f => String(f.key) === '大小倍率');
      if (idxx >= 0) list[idxx] = { key: '大小倍率', type: 'number', value: String(sc) };
      else list.unshift({ key: '大小倍率', type: 'number', value: String(sc) });
    }
    const zOrderInput = el.querySelector('#node-z-order');
    if (zOrderInput) {
      const z = Math.round(parseFloat(zOrderInput.value || '0') || 0);
      const idxz = list.findIndex(f => String(f.key) === '覆盖顺序');
      if (idxz >= 0) list[idxz] = { key: '覆盖顺序', type: 'number', value: String(z) };
      else list.unshift({ key: '覆盖顺序', type: 'number', value: String(z) });
    }
    node.fields = list;
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
      lbl.style.background = '#fff';
      lbl.style.border = '1px solid #e5e7eb';
      lbl.style.borderRadius = '6px';
      lbl.style.fontSize = '12px';
      lbl.style.cursor = 'move';
      lbl.style.zIndex = 3;

      entry = { box, label: lbl };
      groupDomCache.set(key, entry);
    }

    const { box, label } = entry;
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
        for (let i = 0; i < eles.length; i++) {
          const n = eles[i];
          const id = n.id();
          const pos = n.position();
          try { await axios.put(`/api/nodes/${id}`, { position: pos }); } catch {}
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
    pathEl.setAttribute('fill', hexToRgba(color, opacity));
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
      lbl.style.background = '#fff';
      lbl.style.border = '1px solid #e5e7eb';
      lbl.style.borderRadius = '6px';
      lbl.style.fontSize = '12px';
      lbl.style.cursor = 'move';
      lbl.style.zIndex = 3;

      entry = { path, label: lbl };
      groupDomCache.set(key, entry);
    }

    const { path, label } = entry;
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
        for (let i = 0; i < eles.length; i++) {
          const n = eles[i];
          const id = n.id();
          const pos = n.position();
          try { await axios.put(`/api/nodes/${id}`, { position: pos }); } catch {}
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
}

async function refreshGroupsCache() {
  try {
    const { data } = await axios.get('/api/groups');
    cachedGroups = Array.isArray(data) ? data : [];
  } catch { cachedGroups = []; }
}

async function bootstrap() {
  await initTemplates();
  await refresh();

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
              list.style.borderTop = '1px solid #eee';
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
    const { data } = await axios.post('/api/nodes', payload);
    await refresh();
    const newNode = cy.getElementById(data.id);
    if (newNode && newNode.nonempty()) { newNode.select(); updateEditor(data.id); }
  }

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

  document.getElementById('search').oninput = (e) => {
    const q = (e.target.value || '').trim();
    const raws = Array.isArray(window.__rawNodes) ? window.__rawNodes : [];
    if (!q) {
      // restore all
      cy.batch(() => {
        cy.nodes().style('display', 'element');
        cy.edges().style('display', 'element');
      });
      updateFocusBySelection();
      return;
    }

    // Parse query with AND/OR support
    const norm = q
      .replaceAll('||', ' OR ')
      .replaceAll('或', ' OR ')
      .replaceAll('&&', ' AND ')
      .replaceAll('与', ' AND ')
      .replace(/\s+/g, ' ') // collapse spaces
      .trim();
    const orGroups = norm.split(/\sOR\s/i);

    const idSet = new Set();

    const matchTerm = (node, term) => {
      term = term.trim();
      if (!term) return false;
      const fields = node.fields || [];
      const has = (pred) => fields.some(pred);
      // key:... value:... or key:value
      const idx = term.indexOf(':');
      if (term.toLowerCase().startsWith('key:')) {
        const pat = term.slice(4);
        return has(f => String(f.key || '').includes(pat));
      }
      if (term.toLowerCase().startsWith('value:')) {
        const pat = term.slice(6);
        return has(f => String(f.value || '').includes(pat));
      }
      if (idx > 0) {
        const kpat = term.slice(0, idx);
        const vpat = term.slice(idx + 1);
        return has(f => String(f.key || '').includes(kpat) && String(f.value || '').includes(vpat));
      }
      // default: value search
      return has(f => String(f.value || '').includes(term));
    };

    const groupMatches = (node, group) => {
      // AND between tokens in group (split on spaces and AND keywords)
      const tokens = group.split(/\sAND\s|\s+/i).filter(Boolean);
      return tokens.every(t => matchTerm(node, t));
    };

    raws.forEach(n => {
      if (orGroups.some(g => groupMatches(n, g))) {
        idSet.add(n.id);
      }
    });

    cy.batch(() => {
      cy.nodes().forEach(n => n.style('display', idSet.has(n.id()) ? 'element' : 'none'));
      cy.edges().forEach(eh => {
        const s = eh.source().id();
        const t = eh.target().id();
        const visible = idSet.has(s) && idSet.has(t);
        eh.style('display', visible ? 'element' : 'none');
      });
    });
  // 过滤后也应用聚焦态
  updateFocusBySelection();
  };

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
          const blob = await cy.png({ output: 'blob', full: true, scale: s, bg: '#ffffff' });
          if (blob && blob.size > 0) { const url = URL.createObjectURL(blob); makeDownload(url); setTimeout(()=>URL.revokeObjectURL(url),1500); return; }
        } catch {}
      }
      // 2) 全图 base64，递减 scale
      for (const s of scales) {
        try {
          const data = cy.png({ output: 'base64uri', full: true, scale: s, bg: '#ffffff' });
          if (data && typeof data === 'string' && data.startsWith('data:image/png')) { makeDownload(data); return; }
        } catch {}
      }
      // 3) 仅视窗 Blob/base64
      try {
        const blob = await cy.png({ output: 'blob', full: false, scale: 2, bg: '#ffffff' });
        const url = URL.createObjectURL(blob); makeDownload(url); setTimeout(()=>URL.revokeObjectURL(url),1500); return;
      } catch {}
      try {
        const data = cy.png({ output: 'base64uri', full: false, scale: 2, bg: '#ffffff' });
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
  });
  window.addEventListener('mouseup', () => { dragging = false; });
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
