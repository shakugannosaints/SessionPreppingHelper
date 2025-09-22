from __future__ import annotations

import os
from typing import Any, Dict, List
from copy import deepcopy

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from .storage import read_all, write_all, read_templates, write_templates, new_id
from .utils import compute_auto_links, derive_node_style


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="static")
    CORS(app)

    # In-memory history stacks for undo/redo (not persisted)
    undo_stack: List[Dict[str, Any]] = []
    redo_stack: List[Dict[str, Any]] = []
    MAX_HISTORY = 100

    def write_with_undo(new_data: Dict[str, Any], prev_data: Dict[str, Any]) -> None:
        nonlocal undo_stack, redo_stack
        # push previous snapshot
        undo_stack.append(deepcopy(prev_data))
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
        write_with_undo({
            "nodes": body.get("nodes", []),
            "links": body.get("links", []),
            "suppressedAutoPairs": body.get("suppressedAutoPairs", []),
            "autoEdgeOverrides": body.get("autoEdgeOverrides", {}),
            "groups": body.get("groups", []),
        }, prev)
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
        return jsonify(read_all())

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
    @app.post("/api/undo")
    def api_undo():
        nonlocal undo_stack, redo_stack
        if not undo_stack:
            return jsonify({"error": "nothing to undo"}), 400
        current = read_all()
        state = undo_stack.pop()
        redo_stack.append(deepcopy(current))
        write_all(state)
        return jsonify({"ok": True})

    @app.post("/api/redo")
    def api_redo():
        nonlocal undo_stack, redo_stack
        if not redo_stack:
            return jsonify({"error": "nothing to redo"}), 400
        current = read_all()
        state = redo_stack.pop()
        undo_stack.append(deepcopy(current))
        write_all(state)
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
        write_with_undo(new_data, prev)
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

    return app


def main():
    app = create_app()
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="127.0.0.1", port=port, debug=True)


if __name__ == "__main__":
    main()
