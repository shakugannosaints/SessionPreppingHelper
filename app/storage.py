from __future__ import annotations

import os
import atexit
import threading
import time
import uuid
from typing import Any, Dict
from datetime import datetime
from copy import deepcopy

import json as _stdlib_json

try:  # optional acceleration
    import orjson as _orjson  # type: ignore
except Exception:  # pragma: no cover
    _orjson = None  # type: ignore


DATA_PATH = os.path.join(os.path.dirname(__file__), "data.json")
TEMPLATES_PATH = os.path.join(os.path.dirname(__file__), "templates.json")

# In-memory cache and debounced flush
_CACHE: Dict[str, Any] | None = None
_CACHE_LOCK = threading.Lock()
_DIRTY = False
_FLUSH_TIMER: threading.Timer | None = None
_FLUSH_DELAY = float(os.environ.get("STORE_FLUSH_DELAY_SEC", "0.8"))  # seconds


def dumps_bytes(obj: Any) -> bytes:
    if _orjson is not None:
        return _orjson.dumps(obj)  # type: ignore[no-any-return]
    return _stdlib_json.dumps(obj, ensure_ascii=False).encode("utf-8")


def loads_bytes(data: bytes) -> Any:
    if not data:
        return None
    # Fast path
    try:
        if _orjson is not None:
            return _orjson.loads(data)  # type: ignore[no-any-return]
    except Exception:
        pass
    try:
        return _stdlib_json.loads(data.decode("utf-8"))
    except Exception:
        # Let caller attempt salvage
        raise


def _ensure_file(path: str, default: Any) -> None:
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(dumps_bytes(default))


def _load(path: str, default: Any) -> Any:
    _ensure_file(path, default)
    with open(path, "rb") as f:
        raw = f.read()
        if not raw:
            return default
        try:
            data = loads_bytes(raw)
            return data if data is not None else default
        except Exception:
            # Attempt salvage: keep only the first complete JSON object/array
            text = raw.decode("utf-8", errors="ignore").strip()
            start = None
            for i, ch in enumerate(text):
                if ch in "[{":
                    start = i
                    break
            data_obj = None
            if start is not None:
                depth = 0
                in_str = False
                esc = False
                end = None
                for i in range(start, len(text)):
                    ch = text[i]
                    if in_str:
                        if esc:
                            esc = False
                        elif ch == "\\":
                            esc = True
                        elif ch == '"':
                            in_str = False
                    else:
                        if ch == '"':
                            in_str = True
                        elif ch in "[{":
                            depth += 1
                        elif ch in "]}":
                            depth -= 1
                            if depth == 0:
                                end = i
                                break
                    # ignore other characters
                if end is not None and end >= start:
                    candidate = text[start:end+1]
                    try:
                        data_obj = _stdlib_json.loads(candidate)
                        # Backup corrupt file, then save repaired JSON
                        try:
                            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
                            bak = f"{path}.corrupt-{ts}.bak"
                            with open(bak, "wb") as bf:
                                bf.write(raw)
                        finally:
                            _save(path, data_obj)
                        return data_obj
                    except Exception:
                        pass
            # If salvage fails, backup and reset to default
            try:
                ts = datetime.now().strftime("%Y%m%d-%H%M%S")
                bak = f"{path}.corrupt-{ts}.bak"
                with open(bak, "wb") as bf:
                    bf.write(raw)
            finally:
                _save(path, default)
            return default


def _save(path: str, data: Any) -> None:
    payload = dumps_bytes(data)
    tmp_path = f"{path}.tmp"
    # Remove stale tmp file if exists
    try:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    except Exception:
        pass
    try:
        with open(tmp_path, "wb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        # Try replace with small retries to avoid transient locks on Windows
        last_err: Exception | None = None
        for attempt in range(5):
            try:
                os.replace(tmp_path, path)
                last_err = None
                break
            except PermissionError as e:
                last_err = e
                time.sleep(0.15 * (attempt + 1))
        if last_err is not None:
            raise last_err
    except PermissionError as e:
        # Backup original file for diagnosis
        try:
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            bak = f"{path}.permerr-{ts}.bak"
            if os.path.exists(path):
                with open(path, "rb") as orig, open(bak, "wb") as bf:
                    bf.write(orig.read())
        except Exception:
            pass
        raise PermissionError(f"拒绝访问: {path}。请确认无其他程序占用或只读属性。已备份到 {bak}") from e


def _flush_to_disk_safe() -> None:
    global _DIRTY, _FLUSH_TIMER
    # Take a snapshot under lock
    with _CACHE_LOCK:
        local = deepcopy(_CACHE) if _CACHE is not None else default_data()
        _FLUSH_TIMER = None
        dirty = _DIRTY
        _DIRTY = False
    if not dirty:
        return
    try:
        _save(DATA_PATH, local)
    except Exception:
        # If saving fails, mark dirty again to retry on next write
        with _CACHE_LOCK:
            _DIRTY = True


def _schedule_flush() -> None:
    global _FLUSH_TIMER
    # Debounce timer: cancel previous and schedule a new one
    if _FLUSH_TIMER is not None and _FLUSH_TIMER.is_alive():
        try:
            _FLUSH_TIMER.cancel()
        except Exception:
            pass
    _FLUSH_TIMER = threading.Timer(_FLUSH_DELAY, _flush_to_disk_safe)
    _FLUSH_TIMER.daemon = True
    _FLUSH_TIMER.start()


def default_data() -> Dict[str, Any]:
    return {"nodes": [], "links": [], "suppressedAutoPairs": [], "autoEdgeOverrides": {}}


def default_templates() -> Dict[str, Any]:
    return {
        "NPC": [
            {"key": "名称", "type": "text", "value": ""},
            {"key": "标签", "type": "tag", "value": "NPC"},
            {"key": "地点", "type": "text", "value": ""},
            {"key": "动机", "type": "text", "value": ""},
        ],
        "地点": [
            {"key": "名称", "type": "text", "value": ""},
            {"key": "标签", "type": "tag", "value": "地点"},
        ],
    }


def read_all() -> Dict[str, Any]:
    global _CACHE
    with _CACHE_LOCK:
        if _CACHE is None:
            _CACHE = _load(DATA_PATH, default_data())
        local: Dict[str, Any] = _CACHE  # type: ignore[assignment]
    # Return a deepcopy to prevent accidental external mutation of cache structure
    return deepcopy(local)


def write_all(data: Dict[str, Any]) -> None:
    global _CACHE, _DIRTY
    with _CACHE_LOCK:
        _CACHE = deepcopy(data)
        _DIRTY = True
    _schedule_flush()


def read_templates() -> Dict[str, Any]:
    return _load(TEMPLATES_PATH, default_templates())


def write_templates(data: Dict[str, Any]) -> None:
    # Templates are less frequently modified; write-through is acceptable
    _save(TEMPLATES_PATH, data)


def new_id() -> str:
    return uuid.uuid4().hex


# Ensure cache is flushed on process exit
def _finalize_flush() -> None:
    try:
        _flush_to_disk_safe()
    except Exception:
        pass

atexit.register(_finalize_flush)
