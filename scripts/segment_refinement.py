"""Target ownership, bounded output geometry and optional real image matting.

SAM masks describe object membership. They are not alpha estimates. This module
keeps that binary evidence separate from the RGBA result and reports every
unavailable or rejected refinement explicitly. It never installs dependencies.
"""
import importlib
from pathlib import Path
import sys
import warnings

import numpy as np

MAX_MATTING_PIXELS = 250_000
OUTPUT_PADDING = 2


def inference_rgb(rgba):
    """Render alpha against a neutral backdrop for SAM only, never for export."""
    alpha = rgba[:, :, 3:4].astype(np.float32) / 255
    return np.rint(rgba[:, :, :3].astype(np.float32) * alpha + 127 * (1 - alpha)).astype(np.uint8)


def expand_bounds(bounds, padding, width, height):
    left, top, right, bottom = bounds
    return [max(0, left - padding), max(0, top - padding),
            min(width, right + padding), min(height, bottom + padding)]


def inference_bounds(prompt, width, height, points):
    """Keep context around the prompt and all explicitly supplied point prompts."""
    padding = max(12, min(96, round(max(prompt[2] - prompt[0], prompt[3] - prompt[1]) * 0.15)))
    bounds = expand_bounds(prompt, padding, width, height)
    for point in points:
        bounds[0] = min(bounds[0], max(0, point["x"] - 4))
        bounds[1] = min(bounds[1], max(0, point["y"] - 4))
        bounds[2] = max(bounds[2], min(width, point["x"] + 5))
        bounds[3] = max(bounds[3], min(height, point["y"] + 5))
    return bounds


def nonzero_bounds(mask):
    rows, columns = np.nonzero(mask)
    if not len(rows):
        return None
    return [int(columns.min()), int(rows.min()), int(columns.max()) + 1, int(rows.max()) + 1]


def connected_components(mask):
    """Eight-connected scanline labels; diagonal one-pixel details stay together."""
    parents = []
    runs = []

    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    previous = []
    for y, row in enumerate(mask):
        padded = np.concatenate(([False], row, [False]))
        starts = np.flatnonzero(~padded[:-1] & padded[1:])
        ends = np.flatnonzero(padded[:-1] & ~padded[1:])
        current = []
        for left, right in zip(starts.tolist(), ends.tolist()):
            index = len(parents)
            parents.append(index)
            current.append((left, right, index))
            runs.append((y, left, right, index))
        previous_index = 0
        current_index = 0
        while previous_index < len(previous) and current_index < len(current):
            previous_left, previous_right, previous_node = previous[previous_index]
            current_left, current_right, current_node = current[current_index]
            if previous_right < current_left:
                previous_index += 1
                continue
            if current_right < previous_left:
                current_index += 1
                continue
            previous_root = find(previous_node)
            current_root = find(current_node)
            if previous_root != current_root:
                parents[current_root] = previous_root
            if previous_right <= current_right:
                previous_index += 1
            else:
                current_index += 1
        previous = current

    labels = np.zeros(mask.shape, dtype=np.int32)
    records = {}
    for y, left, right, node in runs:
        root = find(node)
        if root not in records:
            records[root] = {"id": len(records) + 1, "pixels": 0, "bounds": [left, y, right, y + 1]}
        record = records[root]
        record["pixels"] += right - left
        bounds = record["bounds"]
        bounds[0] = min(bounds[0], left)
        bounds[1] = min(bounds[1], y)
        bounds[2] = max(bounds[2], right)
        bounds[3] = max(bounds[3], y + 1)
        labels[y, left:right] = record["id"]
    return labels, list(records.values())


def rectangle_gap(first, second):
    return max(first[0] - second[2], second[0] - first[2],
               first[1] - second[3], second[1] - first[3], 0)


def clean_target_components(mask, prompt, points):
    """Remove explicit negative islands and distant, unprompted exterior islands.

    Components inside the prompt and nearby disconnected ornaments are retained.
    A negative point in a positively anchored component is a conflict, not a
    reason to erase the whole object. No largest-component-only shortcut is used.
    """
    labels, components = connected_components(mask)
    left, top, right, bottom = prompt
    positive = {int(labels[p["y"], p["x"]]) for p in points if p["label"] == 1}
    negative = {int(labels[p["y"], p["x"]]) for p in points if p["label"] == 0}
    positive.discard(0)
    negative.discard(0)
    anchored = []
    for component in components:
        component["promptPixels"] = int((labels[top:bottom, left:right] == component["id"]).sum())
        if component["id"] in positive or (component["promptPixels"] and component["id"] not in negative):
            anchored.append(component)
    margin = max(3, min(8, round(min(right - left, bottom - top) * 0.04)))
    kept = []
    removed = []
    for component in components:
        identity = component["id"]
        if identity in positive:
            kept.append(component)
        elif identity in negative:
            removed.append(component)
        elif component["promptPixels"]:
            kept.append(component)
        elif anchored and any(rectangle_gap(component["bounds"], anchor["bounds"]) <= margin for anchor in anchored):
            kept.append(component)
        else:
            removed.append(component)
    selected = np.isin(labels, [component["id"] for component in kept])
    return selected, {
        "removedComponents": len(removed),
        "removedPixels": sum(component["pixels"] for component in removed),
        "retainedComponents": len(kept),
    }


def morphology(mask, radius, operation):
    padded = np.pad(mask, radius, constant_values=False)
    height, width = mask.shape
    result = np.ones_like(mask) if operation == "erode" else np.zeros_like(mask)
    for y in range(radius * 2 + 1):
        for x in range(radius * 2 + 1):
            window = padded[y:y + height, x:x + width]
            if operation == "erode":
                result &= window
            else:
                result |= window
    return result


def build_trimap(mask, radius, points):
    foreground = morphology(mask, radius, "erode")
    support = morphology(mask, radius, "dilate")
    trimap = np.full(mask.shape, 0.5, dtype=np.float64)
    trimap[~support] = 0
    trimap[foreground] = 1
    for point in points:
        # Points are exact pixel constraints. Do not paint over nearby thin art.
        trimap[point["y"], point["x"]] = point["label"]
    return trimap


def load_matting(matting_site):
    if matting_site and Path(matting_site).is_dir():
        location = str(Path(matting_site).resolve())
        if location not in sys.path:
            sys.path.insert(0, location)
    module = importlib.import_module("pymatting")
    return module.estimate_alpha_cf, module.estimate_foreground_ml


def refine_alpha(rgba, mask, points, matting_site=None, excluded=None):
    """Estimate alpha AND foreground colour only in a narrow uncertain band."""
    result = np.array(rgba, copy=True)
    result[~mask, 3] = 0
    details = {"method": "binary-mask", "status": "degraded", "softAlphaPixels": 0,
               "changedRgbPixels": 0, "trimapRadius": 0}
    if not mask.any():
        details["reason"] = "目标蒙版为空，无法进行边缘精修。"
        return result, mask, details

    if (rgba[:, :, 3] < 255).any():
        # Native RGBA already stores foreground RGB and alpha, unlike a screenshot.
        # Recover only a narrow, unambiguous antialias fringe. A native alpha>0
        # component may also contain a neighbor joined by a faint shadow, or an
        # entire flattened scene with one transparent hole. Never use connectivity
        # alone to restore that component after ownership cleanup rejected it.
        native_labels, _ = connected_components(rgba[:, :, 3] > 0)
        support = mask & (rgba[:, :, 3] > 0)
        identities = np.unique(native_labels[support])
        identities = identities[identities > 0]
        permitted = morphology(mask, 3, "dilate")
        if excluded is not None:
            permitted[excluded] = False
        for point in points:
            if point["label"] == 0:
                permitted[point["y"], point["x"]] = False
        limited_components = 0
        for identity in identities:
            component = native_labels == identity
            if np.any(component & ~permitted):
                limited_components += 1
                continue
            support |= component
        result[:, :, 3] = np.where(support, rgba[:, :, 3], 0)
        details.update(method="source-alpha", status="preserved")
        if limited_components:
            details["reason"] = "原生透明度与较远区域或排除区域连通，仅保留已归属的原生像素；请检查细节边缘。"
        details["softAlphaPixels"] = int(((result[:, :, 3] > 0) & (result[:, :, 3] < 255)).sum())
        return result, support, details

    if mask.size > MAX_MATTING_PIXELS:
        details["reason"] = f"精修区域超过 {MAX_MATTING_PIXELS} 像素；保留粗蒙版，请缩小目标区域后重试。"
        return result, mask, details
    radius = max(1, min(3, round(min(mask.shape) / 32)))
    trimap = build_trimap(mask, radius, points)
    details["trimapRadius"] = radius
    if not (trimap == 1).any() or not (trimap == 0).any():
        details["reason"] = "缺少可靠的前景或背景种子；保留粗蒙版，请调整框选或正负提示点。"
        return result, mask, details
    try:
        estimate_alpha, estimate_foreground = load_matting(matting_site)
    except Exception as error:
        details["reason"] = f"本地 PyMatting 不可用（{type(error).__name__}）；当前结果仍为粗蒙版。"
        return result, mask, details

    image = rgba[:, :, :3].astype(np.float64) / 255
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            alpha = estimate_alpha(image, trimap, laplacian_kwargs={"epsilon": 1e-7},
                                   cg_kwargs={"maxiter": 2000})
            foreground = estimate_foreground(image, alpha)
        if caught:
            details["reason"] = "精修求解产生数值警告；保留粗蒙版。"
            return result, mask, details
        if alpha.shape != mask.shape or foreground.shape != image.shape or not (
                np.isfinite(alpha).all() and np.isfinite(foreground).all()):
            details["reason"] = "精修结果包含无效数值；保留粗蒙版。"
            return result, mask, details
        alpha = np.clip(alpha, 0, 1)
        alpha[trimap == 0] = 0
        alpha[trimap == 1] = 1
        mass_ratio = float(alpha.sum() / max(1, mask.sum()))
        if mass_ratio < 0.5 or mass_ratio > 1.8:
            details["reason"] = "精修导致目标面积异常变化；保留粗蒙版，请检查提示点。"
            return result, mask, details
        result[:, :, 3] = np.rint(alpha * 255).astype(np.uint8)
        uncertain = (trimap == 0.5) & (result[:, :, 3] > 0)
        estimated_rgb = np.rint(np.clip(foreground, 0, 1) * 255).astype(np.uint8)
        result[uncertain, :3] = estimated_rgb[uncertain]
        details.update(method="pymatting-cf", status="applied")
        details["softAlphaPixels"] = int(((result[:, :, 3] > 0) & (result[:, :, 3] < 255)).sum())
        details["changedRgbPixels"] = int(np.any(result[:, :, :3] != rgba[:, :, :3], axis=2).sum())
        return result, mask, details
    except Exception as error:
        details["reason"] = f"精修求解失败（{type(error).__name__}）；保留粗蒙版。"
        return result, mask, details


def prepare_output(image, roi_mask, prompt, roi, points, matting_site=None):
    """Return full-image binary evidence, refined RGBA, and auditable geometry."""
    original = np.asarray(image, dtype=np.uint8)
    height, width = original.shape[:2]
    left, top, right, bottom = roi
    local_prompt = [prompt[0] - left, prompt[1] - top, prompt[2] - left, prompt[3] - top]
    local_points = [{"x": point["x"] - left, "y": point["y"] - top, "label": point["label"]} for point in points]
    selected, component_report = clean_target_components(roi_mask, local_prompt, local_points)
    excluded = roi_mask & ~selected
    crop, selected, refinement = refine_alpha(original[top:bottom, left:right], selected, local_points, matting_site, excluded)
    issues = []

    def issue(code, message, severity="warning"):
        issues.append({"code": code, "severity": severity, "message": message})

    if component_report["removedComponents"]:
        issue("removed-exterior-components", f"已去除 {component_report['removedComponents']} 个负点指定或远离目标的独立区域，请复查装饰完整性。")
    if component_report["retainedComponents"] > 1:
        issue("disconnected-details", "保留了目标附近的断开细节；请确认它们属于同一资源。")
    for point in local_points:
        is_foreground = bool(selected[point["y"], point["x"]])
        if is_foreground != bool(point["label"]):
            issue("point-conflict", "目标蒙版与正负提示点冲突，请调整提示点后重试。", "error")
            break
    visible_support = selected | (crop[:, :, 3] > 0)
    internal_touch = ((left > 0 and visible_support[:, 0].any()) or (top > 0 and visible_support[0, :].any()) or
                      (right < width and visible_support[:, -1].any()) or (bottom < height and visible_support[-1, :].any()))
    if internal_touch:
        issue("inference-edge-contact", "目标触及推理区域边缘，可能仍有缺失或包含邻近元素；请扩大目标框或增加负点。", "error")
    elif ((left == 0 and visible_support[:, 0].any()) or (top == 0 and visible_support[0, :].any()) or
          (right == width and visible_support[:, -1].any()) or (bottom == height and visible_support[-1, :].any())):
        issue("source-edge-contact", "目标触及原图边缘，原图外的内容无法通过分割恢复。")
    prompt_pixels = int(selected[local_prompt[1]:local_prompt[3], local_prompt[0]:local_prompt[2]].sum())
    outside_fraction = 1 - prompt_pixels / max(1, int(selected.sum()))
    if outside_fraction > 0.6:
        issue("excessive-expansion", "大部分蒙版位于提示框外，可能选中了背景或邻近元素。", "error")
    if refinement["status"] == "degraded":
        issue("refinement-degraded", refinement["reason"])
    elif refinement["method"] == "source-alpha" and refinement.get("reason"):
        issue("native-alpha-limited", refinement["reason"])
    local_mask_bounds = nonzero_bounds(selected)
    visible_bounds = nonzero_bounds(crop[:, :, 3] > 0)
    if local_mask_bounds is None or visible_bounds is None:
        raise ValueError("目标没有可见像素；请检查框选、原图透明度和提示点")
    mask_bounds = [local_mask_bounds[0] + left, local_mask_bounds[1] + top,
                   local_mask_bounds[2] + left, local_mask_bounds[3] + top]
    content_bounds = [min(local_mask_bounds[0], visible_bounds[0]) + left,
                      min(local_mask_bounds[1], visible_bounds[1]) + top,
                      max(local_mask_bounds[2], visible_bounds[2]) + left,
                      max(local_mask_bounds[3], visible_bounds[3]) + top]
    output = expand_bounds(content_bounds, OUTPUT_PADDING, width, height)
    output = [max(left, output[0]), max(top, output[1]), min(right, output[2]), min(bottom, output[3])]
    full_mask = np.zeros((height, width), dtype=np.uint8)
    full_mask[top:bottom, left:right] = selected.astype(np.uint8) * 255
    full_rgba = np.zeros_like(original)
    full_rgba[top:bottom, left:right] = crop
    full_rgba[full_rgba[:, :, 3] == 0, :3] = 0
    diagnostics = {
        "promptBounds": prompt, "inferenceBounds": roi, "maskBounds": mask_bounds, "outputBounds": output,
        "quality": {"status": "failed" if any(item["severity"] == "error" for item in issues) else "review",
                    "issues": issues, **component_report},
        "refinement": refinement,
    }
    return full_mask, full_rgba, diagnostics
