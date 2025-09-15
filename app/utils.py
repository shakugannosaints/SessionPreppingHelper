from __future__ import annotations

from typing import Any, Dict, List, Tuple


def stable_color_for_tag(tag: str) -> str:
    presets = {
        "NPC": "#4F8EF7",
        "地点": "#34C759",
        "剧情": "#F59E0B",
    }
    if tag in presets:
        return presets[tag]
    # simple stable hash -> color
    h = 0
    for ch in tag:
        h = (h * 131 + ord(ch)) & 0xFFFFFF
    r = (h >> 16) & 0xFF
    g = (h >> 8) & 0xFF
    b = h & 0xFF
    return f"#{r:02X}{g:02X}{b:02X}"


def derive_node_style(node: Dict[str, Any]) -> Dict[str, Any]:
    tags: List[str] = [f["value"] for f in node.get("fields", []) if f.get("type") == "tag" and isinstance(f.get("value"), str)]
    colors = [stable_color_for_tag(t) for t in tags] or ["#9CA3AF"]
    size_base = 30
    max_num = 0.0
    for f in node.get("fields", []):
        if f.get("type") == "number":
            try:
                v = float(f.get("value", 0))
                if v > max_num:
                    max_num = v
            except Exception:
                pass
    size = size_base + min(max_num, 100) * 0.5  # 30 ~ 80 approx
    return {"colors": colors, "size": size}


def compute_auto_links(nodes: List[Dict[str, Any]], filter_field_keys: List[str] | None = None) -> List[Dict[str, Any]]:
    # explicit fields index: (key,value) -> node ids
    index: Dict[Tuple[str, str], List[str]] = {}
    for n in nodes:
        nid = n.get("id")
        if not isinstance(nid, str) or not nid:
            continue
        for f in n.get("fields", []):
            k = f.get("key")
            v = f.get("value")
            if not isinstance(k, str) or not isinstance(v, str):
                continue
            if filter_field_keys and k not in filter_field_keys:
                continue
            index.setdefault((k, v), []).append(nid)

    auto_links: List[Dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    # Rule B: semantic linking — for each node with 标签(tag)=T and 名称(text)=N,
    # link to nodes that explicitly have field key=T and value=N.
    for n in nodes:
        nid = n.get("id")
        if not isinstance(nid, str) or not nid:
            continue
        fields = n.get("fields", []) or []
        # name: prefer key == '名称' and type 'text'
        name_val = None
        for f in fields:
            if f.get("key") == "名称" and f.get("type") == "text" and isinstance(f.get("value"), str):
                name_val = f.get("value")
                break
        if not isinstance(name_val, str) or not name_val:
            continue
        # tags list
        tags = [f.get("value") for f in fields if f.get("type") == "tag" and isinstance(f.get("value"), str)]
        for tag in tags:
            if not isinstance(tag, str) or not tag:
                continue
            if filter_field_keys and tag not in filter_field_keys:
                continue
            target_ids = index.get((tag, name_val), [])
            for tid in target_ids:
                if tid == nid:
                    continue
                key = (nid, tid) if nid <= tid else (tid, nid)
                if key in seen:
                    continue
                seen.add(key)
                # Direction: point to the node that has the tag (nid)
                auto_links.append({
                    "id": f"auto-{tid}-{nid}",
                    "source": tid,
                    "target": nid,
                    "type": "auto",
                    "rule": "B",
                    "label": f"{tag}:{name_val}",
                })


    return auto_links
