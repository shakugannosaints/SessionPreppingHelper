let cy;
let selectedNode = null;
let linkPick = [];
let sidebarWidth = 320;
// in-memory curvature overrides (for auto edges or session-only)
const edgeCpd = new Map();
// 聚焦模式状态：仅当双击同一节点后才进入
let focusNodeId = null;
let lastTapNodeId = null;
let lastTapTime = 0;
const DOUBLE_TAP_MS = 350;

function mapNode(n) {
  const colors = n.style?.colors || ["#9CA3AF"]; 
  const size = n.style?.size || 40;
  const gradient = colors.length > 1 ? `linear-gradient(${colors.join(',')})` : colors[0];
  const labelField = (n.fields || []).find(f => f.key === '名称') || (n.fields || []).find(f => f.type === 'text');
  const label = labelField ? String(labelField.value || '') : (n.id || '');
  return {
    data: { id: n.id, label },
    position: n.position || undefined,
    style: {
      'background-color': colors[0],
      'width': size,
      'height': size,
      'label': label,
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': 12,
      'color': '#111',
      'text-outline-color': '#fff',
      'text-outline-width': 2,
      'border-width': 2,
      'border-color': '#fff',
    }
  };
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
  const field = document.getElementById('rel-filter').value;
  const url = field ? `/api/data?field=${encodeURIComponent(field)}` : '/api/data';
  const { data } = await axios.get(url);
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
  boxSelectionEnabled: false,
  wheelSensitivity: 0.15,
  minZoom: 0.2,
  maxZoom: 3,
  style: [
      { selector: 'node', style: { 'background-color': '#9CA3AF' } },
  { selector: 'edge', style: { 'curve-style': 'unbundled-bezier', 'edge-distances': 'node-position', 'line-color': '#CBD5E1', 'width': 2, 'label': 'data(label)', 'font-size': 10, 'text-background-opacity': 1, 'text-background-color': '#fff', 'text-background-padding': 2, 'target-arrow-shape': 'triangle', 'target-arrow-color': '#CBD5E1', 'control-point-distance': 'data(cpd)', 'control-point-weight': 0.5, 'text-rotation': 'autorotate' } },
  // 聚焦模式：非邻域淡化
  { selector: 'node.faded', style: { 'opacity': 0.15, 'text-opacity': 0.2 } },
  { selector: 'edge.faded', style: { 'opacity': 0.12, 'text-opacity': 0.0 } },
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

  // 应用边文本显示开关状态
  const labelToggle = document.getElementById('toggle-edge-labels');
  const showLabels = labelToggle ? !!labelToggle.checked : true;
  applyEdgeLabelVisibility(showLabels);

  cy.on('tap', 'node', (evt) => {
    const n = evt.target;
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

  cy.on('position', 'node', async (evt) => {
    const id = evt.target.id();
    const pos = evt.target.position();
    await axios.put(`/api/nodes/${id}`, { position: pos });
  });

  // 在每次渲染后绑定：点击手动连线删除
  cy.on('tap', 'edge.manual', async (evt) => {
    const edge = evt.target;
    const id = edge.id();
    if (confirm('删除该手动连接？')) {
      await axios.delete(`/api/links/${id}`);
      await refresh();
    }
  });

  // 点击自动连线：抑制该条自动关联
  cy.on('tap', 'edge.auto', async (evt) => {
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

async function refresh() {
  const { nodes, edges, rawNodes } = await loadData();
  renderGraph(nodes, edges);
  window.__rawNodes = rawNodes;
  await renderSuppressed();
  await updateHistoryButtons();
  // 渲染后根据当前选择应用聚焦态
  updateFocusBySelection();
}

function editorHtml(node) {
  const fields = node.fields || [];
  return `
    <div>
  <div class="muted" style="margin-bottom:6px;">ID: ${(node.id ?? '').toString().replace(/</g,'&lt;')}</div>
      ${fields.map((f, i) => `
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
    node.fields = rows.map(r => ({
      key: r.querySelector('[data-k]').value,
      type: r.querySelector('[data-t]').value,
      value: r.querySelector('[data-v]').value,
    }));
    node.fields.push({ key: '', type: 'text', value: '' });
    updateEditor(id);
  };
  el.querySelector('#save-fields').onclick = async () => {
    const rows = [...el.querySelectorAll('.field-row')];
    const fields = rows.map(r => ({
      key: r.querySelector('[data-k]').value.trim(),
      type: r.querySelector('[data-t]').value,
      value: r.querySelector('[data-v]').value,
    })).filter(f => f.key);
    await axios.put(`/api/nodes/${id}`, { fields });
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
    node.fields = rows.map(r => ({
      key: r.querySelector('[data-k]').value,
      type: r.querySelector('[data-t]').value,
      value: r.querySelector('[data-v]').value,
    }));
    node.fields.splice(idx, 1);
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

async function bootstrap() {
  await initTemplates();
  await refresh();

  document.getElementById('btn-new-node').onclick = async () => {
  const center = getViewportCenter();
  const payload = center ? { fields: [], position: center } : { fields: [] };
  const { data } = await axios.post('/api/nodes', payload);
    await refresh();
    selectedNode = cy.getElementById(data.id);
    selectedNode.select();
    updateEditor(data.id);
  };

  document.getElementById('btn-apply-template').onclick = async () => {
    const sel = document.getElementById('template-select');
    const name = sel.value;
    if (!name) return;
    const tpls = JSON.parse(sel.dataset.templates || '{}');
    const fields = (tpls[name] || []).map(f => ({ ...f }));
  const center = getViewportCenter();
  const payload = center ? { fields, position: center } : { fields };
  const { data } = await axios.post('/api/nodes', payload);
    await refresh();
    selectedNode = cy.getElementById(data.id);
    selectedNode.select();
    updateEditor(data.id);
  };
  const dupBtn = document.getElementById('btn-duplicate');
  if (dupBtn) dupBtn.onclick = async () => { await duplicateSelectedNode(); };

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

  document.getElementById('rel-filter').onchange = refresh;
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
    try { await axios.post('/api/undo'); } finally { await refresh(); }
  };
  document.getElementById('btn-redo').onclick = async () => {
    try { await axios.post('/api/redo'); } finally { await refresh(); }
  };

  // 快捷键：Ctrl+Z / Ctrl+Y 及其他
  window.addEventListener('keydown', async (ev) => {
    const ctrl = ev.ctrlKey || ev.metaKey; // 兼容 mac
    if (!ctrl) return;
    // 避免在输入框中触发
    const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || ev.target?.isContentEditable) return;
    if (ev.key.toLowerCase() === 'z') { ev.preventDefault(); await axios.post('/api/undo'); await refresh(); }
    else if (ev.key.toLowerCase() === 'y') { ev.preventDefault(); await axios.post('/api/redo'); await refresh(); }
    // 复制节点：Ctrl+Shift+K（避免与浏览器快捷键冲突）
    else if (ev.shiftKey && ev.key.toLowerCase() === 'k') { ev.preventDefault(); await duplicateSelectedNode(); }
  });

  // 无修饰快捷键：避免在输入框中触发
  window.addEventListener('keydown', async (ev) => {
    const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || ev.target?.isContentEditable) return;
    const key = ev.key.toLowerCase();
    // 新建节点：N
    if (key === 'n') { ev.preventDefault(); const btn = document.getElementById('btn-new-node'); if (btn) btn.click(); }
    // 开始连线：L 或 A
    else if (key === 'l' || key === 'a') { ev.preventDefault(); const btn = document.getElementById('btn-start-link'); if (btn) btn.click(); }
    // 为选中节点添加字段：F
    else if (key === 'f') { ev.preventDefault(); const b = document.querySelector('#node-editor #add-field'); if (b) b.click(); }
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
      // 清空搜索时，恢复显示 + 应用聚焦态
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
    cy.nodes().removeClass('faded');
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

    const queue = [{ id: node.id(), d: 0 }];
    const seen = new Set([node.id()]);
    const keepNodes = new Set([node.id()]);
    const keepEdges = new Set();

    while (queue.length) {
      const cur = queue.shift();
      if (cur.d >= depth) continue;
      // 从当前节点出发，考虑其可见邻接边与对端
      visibleEdges.forEach(e => {
        const s = e.data('source');
        const t = e.data('target');
        if (s === cur.id || t === cur.id) {
          const other = (s === cur.id) ? t : s;
          if (!visibleNodes.has(other)) return; // 对端被隐藏则忽略
          keepEdges.add(e.id());
          keepNodes.add(other);
          if (!seen.has(other)) {
            seen.add(other);
            queue.push({ id: other, d: cur.d + 1 });
          }
        }
      });
    }

    // 应用淡化：仅保留 keepNodes 与 keepEdges
    cy.nodes().forEach(n => { if (!keepNodes.has(n.id())) n.addClass('faded'); });
    cy.edges().forEach(e => { if (!keepEdges.has(e.id())) e.addClass('faded'); });
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
