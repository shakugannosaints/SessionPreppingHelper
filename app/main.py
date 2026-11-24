from __future__ import annotations

import os
from typing import Any, Dict, List
from copy import deepcopy

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from .storage import (
    read_all, write_all, read_templates, write_templates, new_id,
    read_layers, write_layers,
)
from .utils import compute_auto_links, derive_node_style


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="static")
    CORS(app)

    # In-memory history stacks for undo/redo (not persisted)
    undo_stack: List[Dict[str, Any]] = []
    redo_stack: List[Dict[str, Any]] = []
    MAX_HISTORY = 100

    def write_with_undo(
        new_data: Dict[str, Any],
        prev_data: Dict[str, Any],
        prev_layers: Dict[str, Any] | None = None,
    ) -> None:
        nonlocal undo_stack, redo_stack
        # 一条历史记录同时携带主数据与图层快照。
        # prev_layers=None 表示该操作没有改动图层，撤销时保持图层不变。
        undo_stack.append({
            "data": deepcopy(prev_data),
            "layers": deepcopy(prev_layers) if prev_layers is not None else None,
        })
        if len(undo_stack) > MAX_HISTORY:
            undo_stack.pop(0)
        # any new mutation clears redo
        redo_stack.clear()
        write_all(new_data)

    @app.get("/")
    def index():
        # app.static_folder may be None in typing; default to 'static'
        static_dir = app.static_folder or "static"
        return send_from_directory(static_dir, "index.html")

    @app.get("/api/data")
    def get_data():
        data = read_all()
        nodes = data.get("nodes", [])
        # 图层视图：只返回该图层成员，并用图层专属位置覆盖节点位置
        layer_id = request.args.get("layer")
        if layer_id:
            layer_doc = read_layers()
            layer = next((l for l in layer_doc.get("layers", []) if l.get("id") == layer_id), None)
            if layer:
                member_ids = set(layer.get("members", []) or [])
                positions = layer.get("positions", {}) or {}
                filtered_nodes = []
                for n in nodes:
                    if n.get("id") not in member_ids:
                        continue
                    nn = deepcopy(n)
                    pos = positions.get(n.get("id"))
                    if isinstance(pos, dict) and isinstance(pos.get("x"), (int, float)) and isinstance(pos.get("y"), (int, float)):
                        nn["position"] = {"x": pos["x"], "y": pos["y"]}
                    filtered_nodes.append(nn)
                nodes = filtered_nodes
        # add computed styles
        for n in nodes:
            n["style"] = derive_node_style(n)
        field_filter = request.args.get("field")
        filters = [field_filter] if field_filter else None
        auto_links = compute_auto_links(nodes, filters)
        suppressed: set[tuple[str, str]] = set()
        for p in data.get("suppressedAutoPairs", []) or []:
            a = p.get("a"); b = p.get("b")
            if isinstance(a, str) and isinstance(b, str):
                pair = (a, b) if a <= b else (b, a)
                suppressed.add(pair)
        filtered_auto = []
        for e in auto_links:
            s = e.get("source"); t = e.get("target")
            if isinstance(s, str) and isinstance(t, str):
                pair = (s, t) if s <= t else (t, s)
                if pair in suppressed:
                    continue
            filtered_auto.append(e)
        # apply curvature overrides for auto edges
        overrides = data.get("autoEdgeOverrides", {}) or {}
        for e in filtered_auto:
            s = e.get("source"); t = e.get("target")
            if isinstance(s, str) and isinstance(t, str):
                key = f"{s}->{t}"
                val = overrides.get(key)
                try:
                    if isinstance(val, (int, float, str)):
                        e["cpd"] = float(val)
                except Exception:
                    pass
        auto_links = filtered_auto
        return jsonify({
            "nodes": nodes,
            "links": data.get("links", []),
            "autoLinks": auto_links,
            "groups": data.get("groups", []),
        })

    @app.post("/api/nodes")
    def create_node():
        body = request.get_json(force=True, silent=True) or {}
        data = read_all()
        prev = deepcopy(data)
        node = {
            "id": new_id(),
            "fields": body.get("fields", []),
            "position": body.get("position"),
        }
        data.setdefault("nodes", []).append(node)
        write_with_undo(data, prev)
        # 图层视图下新建：同时写入该图层的成员与独立位置
        layer_id = body.get("layerId")
        if isinstance(layer_id, str):
            doc = read_layers()
            layer = next((l for l in doc.get("layers", []) if l.get("id") == layer_id and l.get("kind") == "layer"), None)
            if layer:
                members = layer.setdefault("members", [])
                if node["id"] not in members:
                    members.append(node["id"])
                p = node.get("position")
                if isinstance(p, dict) and isinstance(p.get("x"), (int, float)) and isinstance(p.get("y"), (int, float)):
                    layer.setdefault("positions", {})[node["id"]] = {"x": p["x"], "y": p["y"]}
                write_layers(doc)
        node["style"] = derive_node_style(node)
        return jsonify(node)

    @app.put("/api/nodes/<node_id>")
    def update_node(node_id: str):
        body = request.get_json(force=True, silent=True) or {}
        data = read_all()
        prev = deepcopy(data)
        nodes: List[Dict[str, Any]] = data.get("nodes", [])
        for n in nodes:
            if n.get("id") == node_id:
                if "fields" in body:
                    n["fields"] = body["fields"]
                if "position" in body:
                    n["position"] = body["position"]
                write_with_undo(data, prev)
                n["style"] = derive_node_style(n)
                return jsonify(n)
        return jsonify({"error": "not found"}), 404

    @app.post("/api/nodes/positions")
    def update_positions_batch():
        body = request.get_json(force=True, silent=True) or {}
        # Accept either a list of {id, position} or a dict id->position
        items: List[Dict[str, Any]] = []
        if isinstance(body, list):
            items = [x for x in body if isinstance(x, dict) and isinstance(x.get("id"), str) and isinstance(x.get("position"), dict)]
        elif isinstance(body, dict):
            # when dict, consider { id: {x:.., y:..}, ... }
            for k, v in body.items():
                if isinstance(k, str) and isinstance(v, dict):
                    items.append({"id": k, "position": v})
        if not items:
            return jsonify({"error": "invalid body"}), 400
        data = read_all()
        prev = deepcopy(data)
        nodes: List[Dict[str, Any]] = data.get("nodes", [])
        id_to_pos = {x["id"]: x["position"] for x in items}
        updated = 0
        for n in nodes:
            nid = n.get("id")
            if isinstance(nid, str) and nid in id_to_pos:
                n["position"] = id_to_pos[nid]
                updated += 1
        if updated == 0:
            return jsonify({"error": "no match"}), 400
        write_with_undo(data, prev)
        return jsonify({"ok": True, "updated": updated})

    @app.delete("/api/nodes/<node_id>")
    def delete_node(node_id: str):
        data = read_all()
        prev = deepcopy(data)
        nodes: List[Dict[str, Any]] = data.get("nodes", [])
        before = len(nodes)
        nodes[:] = [n for n in nodes if n.get("id") != node_id]
        # remove related manual links
        links: List[Dict[str, Any]] = data.get("links", [])
        links[:] = [l for l in links if l.get("source") != node_id and l.get("target") != node_id]
        if len(nodes) == before:
            return jsonify({"error": "not found"}), 404
        write_with_undo(data, prev)
        # 同步清理所有图层的成员与排版引用，避免留下悬空节点
        doc = read_layers()
        changed = False
        for layer in doc.get("layers", []):
            if node_id in (layer.get("members") or []):
                layer["members"] = [m for m in layer.get("members", []) if m != node_id]
                changed = True
            if node_id in (layer.get("positions") or {}):
                layer.get("positions", {}).pop(node_id, None)
                changed = True
        if changed:
            write_layers(doc)
        return jsonify({"ok": True})

    # manual links
    @app.post("/api/links")
    def create_link():
        body = request.get_json(force=True, silent=True) or {}
        data = read_all()
        prev = deepcopy(data)
        link = {
            "id": new_id(),
            "source": body.get("source"),
            "target": body.get("target"),
            "label": body.get("label"),
            "type": "manual",
        }
        data.setdefault("links", []).append(link)
        write_with_undo(data, prev)
        return jsonify(link)

    @app.delete("/api/links/<link_id>")
    def delete_link(link_id: str):
        data = read_all()
        prev = deepcopy(data)
        links: List[Dict[str, Any]] = data.get("links", [])
        before = len(links)
        links[:] = [l for l in links if l.get("id") != link_id]
        if len(links) == before:
            return jsonify({"error": "not found"}), 404
        write_with_undo(data, prev)
        return jsonify({"ok": True})

    @app.put("/api/links/<link_id>")
    def update_link(link_id: str):
        body = request.get_json(force=True, silent=True) or {}
        data = read_all()
        prev = deepcopy(data)
        links: List[Dict[str, Any]] = data.get("links", [])
        for l in links:
            if l.get("id") == link_id:
                # allow updating optional visual props like curvature (cpd) and label
                if "cpd" in body:
                    val = body.get("cpd")
                    try:
                        if isinstance(val, (int, float, str)):
                            l["cpd"] = float(val)
                    except Exception:
                        pass
                if "label" in body:
                    l["label"] = body.get("label")
                write_with_undo(data, prev)
                return jsonify(l)
        return jsonify({"error": "not found"}), 404

    # templates
    @app.get("/api/templates")
    def get_templates():
        return jsonify(read_templates())

    @app.post("/api/templates")
    def save_templates():
        body = request.get_json(force=True, silent=True) or {}
        if not isinstance(body, dict):
            return jsonify({"error": "invalid body"}), 400
        write_templates(body)
        return jsonify({"ok": True})

    # import/export
    @app.post("/api/import/json")
    def import_json():
        body = request.get_json(force=True, silent=True) or {}
        if not isinstance(body, dict) or "nodes" not in body:
            return jsonify({"error": "invalid data"}), 400
        prev = read_all()
        prev_layers = read_layers()
        nodes_in = [n for n in (body.get("nodes") or []) if isinstance(n, dict)]
        node_ids = {n.get("id") for n in nodes_in}
        node_pos = {n.get("id"): n.get("position") for n in nodes_in}

        # 导入是"整体替换"，图层窗也必须跟着替换：
        # 1) 新格式导出（含 layers）：原样恢复，剔除指向不存在节点的成员/位置与悬空父级；
        # 2) 旧备份（无 layers 但有 groups）：由编组重建图层，保留旧的分组语义；
        # 3) 旧备份且无 groups：图层窗清空。
        if isinstance(body.get("layers"), list):
            restored: List[Dict[str, Any]] = []
            for raw in body["layers"]:
                if not isinstance(raw, dict):
                    continue
                item = deepcopy(raw)
                if item.get("kind") == "layer":
                    seen = set()
                    members = []
                    for m in (item.get("members") or []):
                        if isinstance(m, str) and m in node_ids and m not in seen:
                            seen.add(m)
                            members.append(m)
                    item["members"] = members
                    positions = item.get("positions") or {}
                    item["positions"] = {
                        k: v for k, v in positions.items()
                        if k in seen and isinstance(v, dict)
                    }
                else:
                    item["members"] = []
                    item["positions"] = {}
                restored.append(item)
            folder_ids = {l.get("id") for l in restored if l.get("kind") == "folder"}
            for item in restored:
                if item.get("parentId") not in folder_ids:
                    item["parentId"] = None
            layers_doc: Dict[str, Any] = {"layers": restored}
        else:
            layers_doc = {"layers": []}
            for g in (body.get("groups") or []):
                if not isinstance(g, dict):
                    continue
                seen = set()
                members = []
                for m in (g.get("members") or []):
                    if isinstance(m, str) and m in node_ids and m not in seen:
                        seen.add(m)
                        members.append(m)
                positions: Dict[str, Any] = {}
                for mid in members:
                    p = node_pos.get(mid)
                    if isinstance(p, dict) and isinstance(p.get("x"), (int, float)) and isinstance(p.get("y"), (int, float)):
                        positions[mid] = {"x": p["x"], "y": p["y"]}
                try:
                    op = float(g.get("opacity")) if g.get("opacity") is not None else 0.08
                except Exception:
                    op = 0.08
                layers_doc["layers"].append({
                    "id": new_id(),
                    "label": str(g.get("label") or "编组"),
                    "kind": "layer",
                    "parentId": None,
                    "color": str(g.get("color") or "#3b82f6"),
                    "opacity": op,
                    "members": members,
                    "positions": positions,
                    "sourceGroup": g.get("id"),
                })

        write_with_undo({
            "nodes": body.get("nodes", []),
            "links": body.get("links", []),
            "suppressedAutoPairs": body.get("suppressedAutoPairs", []),
            "autoEdgeOverrides": body.get("autoEdgeOverrides", {}),
            "groups": body.get("groups", []),
        }, prev, prev_layers)
        write_layers(layers_doc)
        return jsonify({"ok": True})

    @app.post("/api/import/csv")
    def import_csv():
        # Accept text/csv in body
        raw = request.get_data(cache=False, as_text=True)
        if not raw:
            return jsonify({"error": "empty body"}), 400
        import csv
        from io import StringIO
        sio = StringIO(raw)
        reader = csv.DictReader(sio)
        nodes_map: Dict[str, Dict[str, Any]] = {}
        auto_id_counter = 0
        for row in reader:
            nid = (row.get("node_id") or "").strip()
            key = (row.get("field_key") or "").strip()
            ftype = (row.get("field_type") or "text").strip() or "text"
            val = (row.get("field_value") or "").strip()
            if not nid:
                auto_id_counter += 1
                nid = f"csv-{auto_id_counter:04d}"
            node = nodes_map.setdefault(nid, {"id": nid, "fields": [], "position": None})
            node["fields"].append({"key": key, "type": ftype, "value": val})
        data = {"nodes": list(nodes_map.values()), "links": []}
        prev = read_all()
        write_with_undo(data, prev)
        return jsonify({"ok": True, "nodes": len(nodes_map)})

    @app.get("/api/export/json")
    def export_json():
        data = read_all()
        # 图层定义、成员与独立排版随主数据一起导出，
        # 保证“导出 → 新建画布 → 导入”后图层窗能完整还原。
        data["layers"] = read_layers().get("layers", [])
        return jsonify(data)

    # suppress/unsuppress auto links between node pairs
    @app.post("/api/auto/suppress")
    def suppress_auto():
        body = request.get_json(force=True, silent=True) or {}
        a = body.get("a"); b = body.get("b")
        if not isinstance(a, str) or not isinstance(b, str) or a == b:
            return jsonify({"error": "invalid pair"}), 400
        data = read_all()
        prev = deepcopy(data)
        pairs = data.setdefault("suppressedAutoPairs", [])
        key = (a, b) if a <= b else (b, a)
        if not any(isinstance(p.get("a"), str) and isinstance(p.get("b"), str) and ((p.get("a"), p.get("b")) if p.get("a") <= p.get("b") else (p.get("b"), p.get("a"))) == key for p in pairs):
            pairs.append({"a": key[0], "b": key[1]})
            write_with_undo(data, prev)
        return jsonify({"ok": True})

    @app.post("/api/auto/unsuppress")
    def unsuppress_auto():
        body = request.get_json(force=True, silent=True) or {}
        a = body.get("a"); b = body.get("b")
        if not isinstance(a, str) or not isinstance(b, str) or a == b:
            return jsonify({"error": "invalid pair"}), 400
        data = read_all()
        prev = deepcopy(data)
        key = (a, b) if a <= b else (b, a)
        pairs = data.setdefault("suppressedAutoPairs", [])
        before = len(pairs)
        def norm_pair(x: Any, y: Any) -> tuple[str, str] | None:
            if isinstance(x, str) and isinstance(y, str):
                return (x, y) if x <= y else (y, x)
            return None
        pairs[:] = [p for p in pairs if norm_pair(p.get("a"), p.get("b")) != key]
        if len(pairs) != before:
            write_with_undo(data, prev)
        return jsonify({"ok": True})

    # Undo/Redo endpoints
    def _history_snapshot() -> Dict[str, Any]:
        return {"data": deepcopy(read_all()), "layers": deepcopy(read_layers())}

    def _restore_history(entry: Any) -> None:
        # 新历史项：data/layers 任一项为 None 表示那部分未变化，跳过。
        # 兼容旧历史项（直接是 data 字典）：只恢复主数据。
        if isinstance(entry, dict) and "data" in entry and "layers" in entry:
            if entry.get("data") is not None:
                write_all(entry["data"])
            if entry.get("layers") is not None:
                write_layers(entry["layers"])
        else:
            write_all(entry)

    @app.post("/api/undo")
    def api_undo():
        nonlocal undo_stack, redo_stack
        if not undo_stack:
            return jsonify({"error": "nothing to undo"}), 400
        state = undo_stack.pop()
        redo_stack.append(_history_snapshot())
        _restore_history(state)
        return jsonify({"ok": True})

    @app.post("/api/redo")
    def api_redo():
        nonlocal undo_stack, redo_stack
        if not redo_stack:
            return jsonify({"error": "nothing to redo"}), 400
        state = redo_stack.pop()
        undo_stack.append(_history_snapshot())
        _restore_history(state)
        return jsonify({"ok": True})

    @app.get("/api/history")
    def api_history():
        return jsonify({"canUndo": len(undo_stack) > 0, "canRedo": len(redo_stack) > 0})

    @app.get("/api/auto/suppressed")
    def list_suppressed():
        data = read_all()
        return jsonify(data.get("suppressedAutoPairs", []))

    # set curvature for auto edge (persist override)
    @app.post("/api/auto/edge/cpd")
    def set_auto_edge_cpd():
        body = request.get_json(force=True, silent=True) or {}
        s = body.get("source"); t = body.get("target"); cpd = body.get("cpd")
        if not isinstance(s, str) or not isinstance(t, str):
            return jsonify({"error": "invalid edge"}), 400
        try:
            if not isinstance(cpd, (int, float, str)):
                return jsonify({"error": "invalid cpd"}), 400
            cpd_val = float(cpd)
        except Exception:
            return jsonify({"error": "invalid cpd"}), 400
        data = read_all()
        prev = deepcopy(data)
        overrides = data.setdefault("autoEdgeOverrides", {})
        overrides[f"{s}->{t}"] = cpd_val
        write_with_undo(data, prev)
        return jsonify({"ok": True})

    @app.get("/api/export/csv")
    def export_csv():
        from io import StringIO
        import csv

        data = read_all()
        sio = StringIO()
        writer = csv.writer(sio)
        writer.writerow(["node_id", "field_key", "field_type", "field_value"])
        for n in data.get("nodes", []):
            nid = n.get("id", "")
            for f in n.get("fields", []) or []:
                writer.writerow([nid, f.get("key", ""), f.get("type", ""), f.get("value", "")])
        payload = sio.getvalue().encode("utf-8-sig")  # BOM for Excel
        return (payload, 200, {"Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=export.csv"})

    @app.get("/api/export/md")
    def export_md():
        data = read_all()
        lines = ["# 节点清单\n"]
        for n in data.get("nodes", []):
            lines.append(f"## {n.get('id')}\n")
            fields = n.get("fields", []) or []
            for f in fields:
                key = f.get("key", "")
                typ = f.get("type", "")
                val = f.get("value", "")
                lines.append(f"- {key} ({typ}): {val}")
            lines.append("")
        payload = "\n".join(lines).encode("utf-8")
        return (payload, 200, {"Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": "attachment; filename=export.md"})

    # reset canvas: clear nodes, links and auto-related settings
    @app.post("/api/reset")
    def api_reset():
        data = read_all()
        prev = deepcopy(data)
        new_data: Dict[str, Any] = {
            "nodes": [],
            "links": [],
            "suppressedAutoPairs": [],
            "autoEdgeOverrides": {},
            "groups": [],
        }
        write_with_undo(new_data, prev, deepcopy(read_layers()))
        # 新建画布等于全新工程：图层/文件夹定义也一并清空，
        # 避免图层窗残留一堆成员为 0 的空壳（需要时由导入的 JSON 恢复）。
        write_layers({"layers": []})
        return jsonify({"ok": True})

    # Groups CRUD
    @app.get("/api/groups")
    def list_groups():
        data = read_all()
        return jsonify(data.get("groups", []))

    @app.post("/api/groups")
    def create_group():
        body = request.get_json(force=True, silent=True) or {}
        label = body.get("label") or "编组"
        members = body.get("members") or []
        if not isinstance(members, list):
            return jsonify({"error": "invalid members"}), 400
        data = read_all()
        prev = deepcopy(data)
        gid = new_id()
        color = body.get("color") or "#3b82f6"
        opacity = body.get("opacity")
        try:
            op = float(opacity) if opacity is not None else 0.08
        except Exception:
            op = 0.08
        group = {"id": gid, "label": str(label), "members": [m for m in members if isinstance(m, str)], "color": str(color), "opacity": op}
        data.setdefault("groups", []).append(group)
        write_with_undo(data, prev)
        return jsonify(group)

    @app.put("/api/groups/<gid>")
    def update_group(gid: str):
        body = request.get_json(force=True, silent=True) or {}
        data = read_all()
        prev = deepcopy(data)
        groups: List[Dict[str, Any]] = data.setdefault("groups", [])
        for g in groups:
            if g.get("id") == gid:
                if "label" in body:
                    g["label"] = str(body.get("label") or "")
                if "members" in body and isinstance(body.get("members"), list):
                    mems = body.get("members") or []
                    g["members"] = [m for m in mems if isinstance(m, str)]
                if "color" in body:
                    g["color"] = str(body.get("color") or "#3b82f6")
                if "opacity" in body:
                    val = body.get("opacity")
                    try:
                        if val is not None:
                            g["opacity"] = float(val)
                    except Exception:
                        pass
                write_with_undo(data, prev)
                return jsonify(g)
        return jsonify({"error": "not found"}), 404

    @app.delete("/api/groups/<gid>")
    def delete_group(gid: str):
        data = read_all()
        prev = deepcopy(data)
        groups: List[Dict[str, Any]] = data.setdefault("groups", [])
        before = len(groups)
        groups[:] = [g for g in groups if g.get("id") != gid]
        if len(groups) == before:
            return jsonify({"error": "not found"}), 404
        write_with_undo(data, prev)
        return jsonify({"ok": True})

    # ===== 图层（PS 式独立排版）=====
    # layers.json 只存图层定义与位置排版；节点字段/连线仍以 data.json 为唯一来源。

    def _is_layer_descendant(layers: List[Dict[str, Any]], child_id: str, ancestor_id: str) -> bool:
        """判断 child_id 是否是 ancestor_id 的后代（含自身），用于阻止成环。"""
        seen = set()
        cur: Any = child_id
        while isinstance(cur, str) and cur not in seen:
            if cur == ancestor_id:
                return True
            seen.add(cur)
            node = next((x for x in layers if x.get("id") == cur), None)
            if not node:
                return False
            cur = node.get("parentId")
        return False

    def _clone_layer_tree(
        layers: List[Dict[str, Any]], source_id: str, new_parent_id: Any,
        created: List[str], visited: set,
    ) -> Any:
        if source_id in visited:
            return None
        visited.add(source_id)
        src = next((x for x in layers if x.get("id") == source_id), None)
        if not src:
            return None
        clone = deepcopy(src)
        clone["id"] = new_id()
        base_label = src.get("label") or ("图层" if src.get("kind") == "layer" else "文件夹")
        clone["label"] = f"{base_label} 副本"
        clone["parentId"] = new_parent_id
        layers.append(clone)
        created.append(clone["id"])
        if src.get("kind") == "folder":
            child_ids = [
                x.get("id") for x in layers
                if x.get("parentId") == source_id
                and x.get("id") != source_id
                and isinstance(x.get("id"), str)
            ]
            for child_id in child_ids:
                _clone_layer_tree(layers, child_id, clone["id"], created, visited)
        return clone

    @app.get("/api/layers")
    def list_layers():
        return jsonify(read_layers().get("layers", []))

    @app.post("/api/layers")
    def create_layer():
        body = request.get_json(force=True, silent=True) or {}
        kind = body.get("kind") if body.get("kind") in ("layer", "folder") else "layer"
        label = str(body.get("label") or ("图层" if kind == "layer" else "文件夹"))
        parent_id = body.get("parentId")
        if not isinstance(parent_id, str):
            parent_id = None
        members = [m for m in (body.get("members") or []) if isinstance(m, str)]
        color = str(body.get("color") or "#3b82f6")
        opacity = body.get("opacity")
        try:
            op = float(opacity) if opacity is not None else 0.08
        except Exception:
            op = 0.08
        doc = read_layers()
        lid = new_id()
        positions: Dict[str, Any] = {}
        # snapshot: 以成员当前（全局）位置作为该图层初始排版
        if kind == "layer" and body.get("snapshot"):
            node_pos = {n.get("id"): n.get("position") for n in read_all().get("nodes", [])}
            for mid in members:
                p = node_pos.get(mid)
                if isinstance(p, dict) and isinstance(p.get("x"), (int, float)) and isinstance(p.get("y"), (int, float)):
                    positions[mid] = {"x": p["x"], "y": p["y"]}
        layer = {
            "id": lid, "label": label, "kind": kind, "parentId": parent_id,
            "color": color, "opacity": op,
            "members": members if kind == "layer" else [],
            "positions": positions if kind == "layer" else {},
        }
        doc.setdefault("layers", []).append(layer)
        write_layers(doc)
        return jsonify(layer)

    @app.put("/api/layers/<lid>")
    def update_layer(lid: str):
        body = request.get_json(force=True, silent=True) or {}
        doc = read_layers()
        layers: List[Dict[str, Any]] = doc.setdefault("layers", [])
        for l in layers:
            if l.get("id") == lid:
                if "label" in body:
                    l["label"] = str(body.get("label") or "")
                if "color" in body:
                    l["color"] = str(body.get("color") or "#3b82f6")
                if "opacity" in body:
                    try:
                        val = body.get("opacity")
                        if val is not None:
                            l["opacity"] = float(val)
                    except Exception:
                        pass
                if "parentId" in body:
                    pid = body.get("parentId")
                    # 只允许 folder 作为父级，且不能把图层挂到自己或自己的后代上（仅做一层校验）
                    if isinstance(pid, str) and pid != lid:
                        target = next((x for x in layers if x.get("id") == pid and x.get("kind") == "folder"), None)
                        # 目标文件夹不能是自身或自身的后代，否则会形成循环嵌套
                        if target and not _is_layer_descendant(layers, pid, lid):
                            l["parentId"] = pid
                        else:
                            l["parentId"] = None
                    else:
                        l["parentId"] = None
                if "members" in body and isinstance(body.get("members"), list) and l.get("kind") == "layer":
                    new_members = [m for m in body["members"] if isinstance(m, str)]
                    old_members = set(l.get("members", []) or [])
                    l["members"] = new_members
                    # 移除成员时清理其位置；新增成员用当前全局位置初始化
                    positions = l.setdefault("positions", {})
                    for mid in list(positions.keys()):
                        if mid not in new_members:
                            positions.pop(mid, None)
                    node_pos = {n.get("id"): n.get("position") for n in read_all().get("nodes", [])}
                    for mid in new_members:
                        if mid in old_members or mid in positions:
                            continue
                        p = node_pos.get(mid)
                        if isinstance(p, dict) and isinstance(p.get("x"), (int, float)) and isinstance(p.get("y"), (int, float)):
                            positions[mid] = {"x": p["x"], "y": p["y"]}
                write_layers(doc)
                return jsonify(l)
        return jsonify({"error": "not found"}), 404

    @app.delete("/api/layers/<lid>")
    def delete_layer(lid: str):
        doc = read_layers()
        layers: List[Dict[str, Any]] = doc.setdefault("layers", [])
        target = next((l for l in layers if l.get("id") == lid), None)
        if not target:
            return jsonify({"error": "not found"}), 404
        # 删除文件夹时，其子图层提升为顶层（不删除子图层）
        for l in layers:
            if l.get("parentId") == lid:
                l["parentId"] = None
        doc["layers"] = [l for l in layers if l.get("id") != lid]
        write_layers(doc)
        return jsonify({"ok": True})

    @app.post("/api/layers/<lid>/duplicate")
    def duplicate_layer(lid: str):
        """复制图层（连同独立排版）；复制文件夹时连同其内部子项一起复制。"""
        doc = read_layers()
        layers: List[Dict[str, Any]] = doc.setdefault("layers", [])
        src = next((l for l in layers if l.get("id") == lid), None)
        if not src:
            return jsonify({"error": "not found"}), 404
        created: List[str] = []
        clone = _clone_layer_tree(layers, lid, src.get("parentId"), created, set())
        write_layers(doc)
        return jsonify({"ok": True, "id": clone["id"] if clone else None, "created": created})

    @app.post("/api/layers/<lid>/dissolve")
    def dissolve_layer(lid: str):
        """解散文件夹：子项提升到同一层；解散图层：清空成员，保留图层定义。"""
        doc = read_layers()
        layers: List[Dict[str, Any]] = doc.setdefault("layers", [])
        target = next((l for l in layers if l.get("id") == lid), None)
        if not target:
            return jsonify({"error": "not found"}), 404
        if target.get("kind") == "folder":
            parent_id = target.get("parentId")
            for l in layers:
                if l.get("parentId") == lid and l.get("id") != lid:
                    l["parentId"] = parent_id
            doc["layers"] = [l for l in layers if l.get("id") != lid]
        else:
            target["members"] = []
            target["positions"] = {}
        write_layers(doc)
        return jsonify({"ok": True})

    @app.post("/api/layers/<lid>/delete-tree")
    def delete_layer_tree(lid: str):
        """删除文件夹及其全部后代；对普通图层等同于删除图层。"""
        doc = read_layers()
        layers: List[Dict[str, Any]] = doc.setdefault("layers", [])
        if not any(l.get("id") == lid for l in layers):
            return jsonify({"error": "not found"}), 404
        doomed = {lid}
        changed = True
        while changed:
            changed = False
            for l in layers:
                pid = l.get("parentId")
                if isinstance(pid, str) and pid in doomed and l.get("id") not in doomed:
                    doomed.add(l.get("id"))
                    changed = True
        doc["layers"] = [l for l in layers if l.get("id") not in doomed]
        write_layers(doc)
        return jsonify({"ok": True, "deleted": list(doomed)})

    @app.post("/api/layers/<lid>/positions")
    def save_layer_positions(lid: str):
        body = request.get_json(force=True, silent=True) or {}
        items: List[Dict[str, Any]] = []
        if isinstance(body, list):
            items = [x for x in body if isinstance(x, dict) and isinstance(x.get("id"), str) and isinstance(x.get("position"), dict)]
        elif isinstance(body, dict):
            for k, v in body.items():
                if isinstance(k, str) and isinstance(v, dict):
                    items.append({"id": k, "position": v})
        if not items:
            return jsonify({"error": "invalid body"}), 400
        doc = read_layers()
        layer = next((l for l in doc.get("layers", []) if l.get("id") == lid and l.get("kind") == "layer"), None)
        if not layer:
            return jsonify({"error": "not found"}), 404
        positions = layer.setdefault("positions", {})
        updated = 0
        for x in items:
            p = x["position"]
            if isinstance(p.get("x"), (int, float)) and isinstance(p.get("y"), (int, float)):
                positions[x["id"]] = {"x": p["x"], "y": p["y"]}
                updated += 1
        write_layers(doc)
        return jsonify({"ok": True, "updated": updated})

    # 从现有编组迁移：每个编组的成员 + 当前位置生成一个图层
    @app.post("/api/layers/migrate-from-groups")
    def migrate_layers_from_groups():
        doc = read_layers()
        layers = doc.setdefault("layers", [])
        data = read_all()
        node_pos = {n.get("id"): n.get("position") for n in data.get("nodes", [])}
        created = []
        for g in data.get("groups", []) or []:
            gid = g.get("id")
            members = [m for m in (g.get("members") or []) if isinstance(m, str)]
            if any(l.get("sourceGroup") == gid for l in layers):
                continue  # 已迁移过
            positions = {}
            for mid in members:
                p = node_pos.get(mid)
                if isinstance(p, dict) and isinstance(p.get("x"), (int, float)) and isinstance(p.get("y"), (int, float)):
                    positions[mid] = {"x": p["x"], "y": p["y"]}
            layer = {
                "id": new_id(), "label": str(g.get("label") or "编组"), "kind": "layer",
                "parentId": None, "color": str(g.get("color") or "#3b82f6"),
                "opacity": float(g.get("opacity")) if isinstance(g.get("opacity"), (int, float)) else 0.08,
                "members": members, "positions": positions, "sourceGroup": gid,
            }
            layers.append(layer)
            created.append(layer)
        if created:
            write_layers(doc)
        return jsonify({"ok": True, "created": len(created), "layers": created})

    # 从编组「导入」到图层窗：按编组把成员和位置同步进图层窗。
    # 与 migrate-from-groups 的区别：migrate 只在首次生成，遇到已存在的 sourceGroup 会跳过；
    # 本接口显式按编组刷新已关联的图层成员（修复导出/导入后图层成员被清空的旧数据），
    # 并为尚无对应图层的编组补建图层。文件夹结构与手动新增的图层不受影响。
    @app.post("/api/layers/import-from-groups")
    def import_layers_from_groups():
        doc = read_layers()
        layers = doc.setdefault("layers", [])
        data = read_all()
        node_pos = {n.get("id"): n.get("position") for n in data.get("nodes", [])}
        created = 0
        refreshed = 0
        member_total = 0
        for g in data.get("groups", []) or []:
            gid = g.get("id")
            members = [m for m in (g.get("members") or []) if isinstance(m, str)]
            positions = {}
            for mid in members:
                p = node_pos.get(mid)
                if isinstance(p, dict) and isinstance(p.get("x"), (int, float)) and isinstance(p.get("y"), (int, float)):
                    positions[mid] = {"x": p["x"], "y": p["y"]}
            # 已关联图层：刷新成员与位置（保留其所在文件夹 parentId 不变）
            existing = next((l for l in layers if l.get("sourceGroup") == gid and l.get("kind") == "layer"), None)
            if existing:
                existing["members"] = list(members)
                existing["positions"] = positions
                existing["label"] = str(g.get("label") or existing.get("label") or "编组")
                if isinstance(g.get("color"), str) and g.get("color"):
                    existing["color"] = g["color"]
                if isinstance(g.get("opacity"), (int, float)):
                    existing["opacity"] = float(g["opacity"])
                refreshed += 1
            else:
                layers.append({
                    "id": new_id(), "label": str(g.get("label") or "编组"), "kind": "layer",
                    "parentId": None, "color": str(g.get("color") or "#3b82f6"),
                    "opacity": float(g.get("opacity")) if isinstance(g.get("opacity"), (int, float)) else 0.08,
                    "members": list(members), "positions": positions, "sourceGroup": gid,
                })
                created += 1
            member_total += len(members)
        if created or refreshed:
            write_layers(doc)
        return jsonify({"ok": True, "created": created, "refreshed": refreshed, "members": member_total})

    return app


def main():
    app = create_app()
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="127.0.0.1", port=port, debug=True)


if __name__ == "__main__":
    main()
