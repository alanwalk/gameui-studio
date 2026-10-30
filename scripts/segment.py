"""One local SAM2.1 request on stdin; exactly one JSON response on stdout."""
import argparse
import base64
import contextlib
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import time
import uuid

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.environ["SAM2_BUILD_CUDA"] = "0"

ROOT = Path(__file__).resolve().parents[1]
SAM2_ROOT = ROOT / ".data" / "segmentation" / "sam2"
DEFAULT_CHECKPOINT = SAM2_ROOT / "sam2.1_hiera_small.pt"
DEFAULT_SITE = SAM2_ROOT / "site"
DEFAULT_SOURCE = SAM2_ROOT / "source"
DEFAULT_CONFIG = "configs/sam2.1/sam2.1_hiera_s.yaml"
MATTING_SITE = ROOT / ".data" / "matting" / "site"
RULE_VERSION = "v1-frozen-no-revision"
WHOLE_CONTROL_KINDS = {"panel", "button"}


def numbers(value, count, name):
    if not isinstance(value, list) or len(value) != count:
        raise ValueError(f"{name} must contain {count} numbers")
    if any(isinstance(item, bool) or not isinstance(item, (int, float))
           or not math.isfinite(item) for item in value):
        raise ValueError(f"{name} must contain finite numbers")
    return value


def read_request(request):
    from PIL import Image

    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")
    has_path = "imagePath" in request
    has_base64 = "imageBase64" in request
    if has_path == has_base64:
        raise ValueError("provide exactly one of imagePath or imageBase64")
    if has_path:
        if not isinstance(request["imagePath"], str) or not request["imagePath"]:
            raise ValueError("imagePath must be a nonempty local path")
        image_path = Path(request["imagePath"])
        if not image_path.is_absolute():
            image_path = ROOT / image_path
        source = image_path
    else:
        encoded = request["imageBase64"]
        if not isinstance(encoded, str):
            raise ValueError("imageBase64 must be raw base64 or an image data URL")
        if encoded.startswith("data:image/"):
            header, encoded = encoded.split(",", 1)
            if not header.endswith(";base64"):
                raise ValueError("image data URL must use base64")
        source = io.BytesIO(base64.b64decode(encoded, validate=True))
    with Image.open(source) as loaded:
        # Coordinates refer to the encoded raster; no EXIF rotation, crop or resize.
        image = loaded.convert("RGBA")
    width, height = image.size
    box = numbers(request.get("bbox"), 4, "bbox")
    if not all(type(value) is int for value in box):
        raise ValueError("bbox must contain integer original-image coordinates")
    x0, y0, x1, y1 = box
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ValueError("bbox must be original-image xyxy within image bounds")
    points = request.get("points", [])
    if not isinstance(points, list):
        raise ValueError("points must be a list of {x,y,label}")
    coordinates, labels = [], []
    for point in points:
        if not isinstance(point, dict):
            raise ValueError("each point must be {x,y,label}")
        x, y = numbers([point.get("x"), point.get("y")], 2, "point")
        if type(x) is not int or type(y) is not int:
            raise ValueError("point coordinates must be original-image integers")
        label = point.get("label")
        if isinstance(label, bool) or not isinstance(label, int) or label not in (0, 1):
            raise ValueError("point label must be integer 1 (foreground) or 0 (background)")
        if not (0 <= x < width and 0 <= y < height):
            raise ValueError("point must be within original-image pixel bounds")
        coordinates.append([x, y])
        labels.append(label)
    kind = request.get("kind", "icon")
    if kind not in ("panel", "button", "icon", "text", "progress", "frame", "decor"):
        raise ValueError("kind is not a supported UI element kind")
    output = request.get("output", "base64")
    if output not in ("files", "base64"):
        raise ValueError("output must be files or base64")
    return image, box, coordinates, labels, kind, output


def png_base64(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def component_metrics(crop):
    """Count four-connected runs without depending on scipy/OpenCV."""
    import numpy as np

    if not crop.any():
        return 0, 0.0

    parents = []
    sizes = []

    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left, right):
        left_root = find(left)
        right_root = find(right)
        if left_root == right_root:
            return
        if sizes[left_root] < sizes[right_root]:
            left_root, right_root = right_root, left_root
        parents[right_root] = left_root
        sizes[left_root] += sizes[right_root]

    previous = []
    for row in crop:
        padded = np.concatenate(([False], row, [False]))
        starts = np.flatnonzero(~padded[:-1] & padded[1:])
        ends = np.flatnonzero(padded[:-1] & ~padded[1:])
        current = []
        for start, end in zip(starts.tolist(), ends.tolist()):
            index = len(parents)
            parents.append(index)
            sizes.append(end - start)
            current.append((start, end, index))

        previous_index = 0
        current_index = 0
        while previous_index < len(previous) and current_index < len(current):
            previous_start, previous_end, previous_node = previous[previous_index]
            current_start, current_end, current_node = current[current_index]
            if previous_end <= current_start:
                previous_index += 1
                continue
            if current_end <= previous_start:
                current_index += 1
                continue
            union(previous_node, current_node)
            if previous_end <= current_end:
                previous_index += 1
            else:
                current_index += 1
        previous = current

    roots = {find(index) for index in range(len(parents))}
    total = int(crop.sum())
    largest = max((sizes[root] for root in roots), default=0)
    return len(roots), largest / max(total, 1)


def candidate_metrics(mask, score, box, points):
    import numpy as np

    x0, y0, x1, y1 = box
    crop = mask[y0:y1, x0:x1]
    height, width = crop.shape
    inside = int(crop.sum())
    total = int(mask.sum())
    rows, cols = np.nonzero(crop)
    alignment = 0.0
    if inside:
        margins = [
            cols.min() / width,
            (width - 1 - cols.max()) / width,
            rows.min() / height,
            (height - 1 - rows.max()) / height,
        ]
        alignment = float(np.mean([max(0.0, 1.0 - 4.0 * gap) for gap in margins]))
    band_x = max(1, round(width * 0.03))
    band_y = max(1, round(height * 0.03))
    edge_support = [
        float(crop[:, :band_x].mean()),
        float(crop[:, -band_x:].mean()),
        float(crop[:band_y, :].mean()),
        float(crop[-band_y:, :].mean()),
    ]
    components, largest_share = component_metrics(crop)
    point_matches = [bool(mask[p["y"], p["x"]]) == bool(p["label"]) for p in points]
    return {
        "modelScore": float(score),
        "scoreIsMeasuredIou": False,
        "insidePixels": inside,
        "outsidePixelsDiagnosticOnly": total - inside,
        "bboxCoverageDiagnosticOnly": inside / crop.size,
        "extentAlignment": alignment,
        "edgeSupport": edge_support,
        "meanEdgeSupport": sum(edge_support) / 4,
        "componentCountInCrop": components,
        "largestComponentShare": largest_share,
        "fragmentShare": 1.0 - largest_share,
        "outsideFraction": (total - inside) / max(total, 1),
        "pointMatches": point_matches,
        "pointAgreement": sum(point_matches) / len(points) if points else None,
    }


def select_candidate(masks, scores, box, points, kind):
    """Frozen UI-aware selection from the fixed-sample benchmark."""
    import numpy as np

    masks = np.asarray(masks)
    scores = np.asarray(scores)
    if masks.ndim != 3 or len(masks) == 0 or scores.shape != (len(masks),):
        raise ValueError("expected N full-image masks and N scores")
    if not np.all((masks == 0) | (masks == 1)) or not np.isfinite(scores).all():
        raise ValueError("masks must be binary and scores finite")
    x0, y0, x1, y1 = box
    height, width = masks.shape[1:]
    if not all(type(value) is int for value in box) or not (
            0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ValueError("bbox must be integer exclusive bounds within the original image")
    for point in points:
        if (type(point["x"]) is not int or type(point["y"]) is not int or
                not (0 <= point["x"] < width and 0 <= point["y"] < height) or
                point["label"] not in (0, 1)):
            raise ValueError("invalid original-image point")

    records = []
    whole_control = kind in WHOLE_CONTROL_KINDS
    for index, mask in enumerate(masks):
        metrics = candidate_metrics(mask.astype(bool), scores[index], box, points)
        score = float(np.clip(scores[index], 0, 1))
        outside_penalty = min(metrics["outsideFraction"], 0.5)
        if whole_control:
            coverage_support = min(metrics["bboxCoverageDiagnosticOnly"] / 0.85, 1.0)
            terms = {
                "score": 0.30 * score,
                "extent": 0.30 * metrics["extentAlignment"],
                "edge": 0.25 * metrics["meanEdgeSupport"],
                "coverageCapped": 0.10 * coverage_support,
                "connected": 0.05 * metrics["largestComponentShare"],
                "outside": -0.08 * outside_penalty,
                "fragment": -0.10 * metrics["fragmentShare"],
            }
        else:
            terms = {
                "score": 0.80 * score,
                "connected": 0.10 * metrics["largestComponentShare"],
                "extent": 0.10 * metrics["extentAlignment"],
                "outside": -0.15 * outside_penalty,
                "fragment": -0.15 * metrics["fragmentShare"],
            }
        terms["points"] = 2.0 * metrics["pointAgreement"] if points else 0.0
        rank = sum(terms.values())
        records.append({
            "index": index,
            "metrics": metrics,
            "rankTerms": terms,
            "rank": rank,
        })
    chosen = max(range(len(records)), key=lambda index: (records[index]["rank"], -index))
    branch = "whole-control" if whole_control else "conservative"
    reason = (
        f"{RULE_VERSION}; kind={kind}; branch={branch}; max composite rank; "
        f"chosen={chosen}; ranks=" +
        ",".join(f"{record['rank']:.6f}" for record in records) +
        "; tie=lower index; no mask edits; outside area is not a failure verdict"
    )
    return chosen, records, reason


def segment(request, checkpoint, site, source, config, threads):
    started = time.perf_counter()
    # Optional dependencies must be prepared explicitly. This matches the offline
    # matting benchmark's isolated directory; missing packages remain diagnostic.
    if MATTING_SITE.is_dir():
        sys.path.insert(0, str(MATTING_SITE))
    os.environ.setdefault("NUMBA_CACHE_DIR", str(ROOT / ".data" / "matting" / "numba-cache"))
    os.environ.setdefault("NUMBA_NUM_THREADS", str(threads))
    import numpy as np
    from PIL import Image
    from segment_refinement import inference_bounds, inference_rgb, prepare_output

    image, box, coordinates, labels, kind, output = read_request(request)
    if not checkpoint.is_file():
        raise FileNotFoundError(
            f"missing checkpoint: {checkpoint}; install explicitly; runtime never downloads")
    if not site.is_dir() or not source.is_dir():
        raise FileNotFoundError(
            "missing SAM2 vendor source/site; install explicitly; runtime never downloads")

    import_started = time.perf_counter()
    import torch
    sys.path.insert(0, str(site))
    sys.path.insert(0, str(source))
    import sam2
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    if Path(sam2.__file__).resolve() != (source / "sam2" / "__init__.py").resolve():
        raise RuntimeError("SAM2 imported from an unexpected path")
    torch.set_num_threads(threads)
    timings = {"importsMs": round((time.perf_counter() - import_started) * 1000, 3)}
    model_started = time.perf_counter()
    model = build_sam2(
        config,
        str(checkpoint),
        device="cpu",
        mode="eval",
        apply_postprocessing=False,
    )
    predictor = SAM2ImagePredictor(
        model,
        mask_threshold=0.0,
        max_hole_area=0.0,
        max_sprinkle_area=0.0,
    )
    timings["modelLoadMs"] = round((time.perf_counter() - model_started) * 1000, 3)

    points = [{"x": coordinate[0], "y": coordinate[1], "label": labels[index]}
              for index, coordinate in enumerate(coordinates)]
    roi = inference_bounds(box, image.width, image.height, points)
    left, top, right, bottom = roi
    local_box = [box[0] - left, box[1] - top, box[2] - left, box[3] - top]
    local_points = [{"x": point["x"] - left, "y": point["y"] - top, "label": point["label"]} for point in points]
    # Hidden RGB beneath alpha=0 is not image content. Composite only the model
    # input; ownership extraction and native foreground colours use the original.
    rgb = inference_rgb(np.asarray(image.crop(tuple(roi)), dtype=np.uint8))
    point_coords = None
    point_labels = None
    if coordinates:
        point_coords = np.asarray([[point["x"], point["y"]] for point in local_points], dtype=np.float32)
        point_labels = np.asarray(labels, dtype=np.int32)
    with torch.inference_mode():
        encode_started = time.perf_counter()
        predictor.set_image(np.array(rgb, copy=True))
        timings["encodeMs"] = round((time.perf_counter() - encode_started) * 1000, 3)
        predict_started = time.perf_counter()
        masks, scores, _ = predictor.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            box=np.asarray(local_box, dtype=np.float32),
            multimask_output=True,
        )
        timings["predictMs"] = round((time.perf_counter() - predict_started) * 1000, 3)

    masks = np.asarray(masks)
    scores = np.asarray(scores)
    if masks.shape != (3, bottom - top, right - left):
        raise RuntimeError("predictor returned masks with incorrect dimensions")
    if not np.all((masks == 0) | (masks == 1)):
        raise RuntimeError("predictor returned non-binary masks")
    chosen_index, candidates, reason = select_candidate(
        masks,
        scores,
        local_box,
        local_points,
        kind,
    )
    mask = masks[chosen_index].astype(np.bool_)
    if not mask.any():
        raise RuntimeError("predictor returned an empty chosen mask; adjust bbox or points")

    refinement_started = time.perf_counter()
    binary_mask, rgba, diagnostics = prepare_output(image, mask, box, roi, points, MATTING_SITE)
    timings["refinementMs"] = round((time.perf_counter() - refinement_started) * 1000, 3)
    # Binary object membership remains separate from the refined continuous alpha.
    mask_image = Image.fromarray(binary_mask)
    target = Image.fromarray(rgba)
    result = {
        "ok": True,
        "protocolVersion": 2,
        "model": "SAM2.1-small",
        "modelType": "sam2.1_hiera_small",
        "device": "cpu",
        "width": image.width,
        "height": image.height,
        "bbox": box,
        "kind": kind,
        **diagnostics,
        "maskPixels": int((binary_mask > 0).sum()),
        "predictedIou": float(scores[chosen_index]),
        "score": float(scores[chosen_index]),
        "chosenIndex": chosen_index,
        "selectionReason": reason,
        "candidates": candidates,
        "checkpointSha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
    }
    save_started = time.perf_counter()
    if output == "base64":
        result["maskBase64"] = png_base64(mask_image)
        result["rgbaBase64"] = png_base64(target)
    else:
        output_dir = SAM2_ROOT / "outputs" / uuid.uuid4().hex
        output_dir.mkdir(parents=True, exist_ok=False)
        mask_path = output_dir / "mask.png"
        rgba_path = output_dir / "target.png"
        mask_image.save(mask_path)
        target.save(rgba_path)
        result["maskPath"] = str(mask_path)
        result["rgbaPath"] = str(rgba_path)
    timings["saveMs"] = round((time.perf_counter() - save_started) * 1000, 3)
    timings["totalMs"] = round((time.perf_counter() - started) * 1000, 3)
    result["timings"] = timings
    result["elapsedMs"] = timings["totalMs"]
    return result


def health(site, source):
    import_started = time.perf_counter()
    sys.path.insert(0, str(site))
    sys.path.insert(0, str(source))
    import torch
    import sam2
    if Path(sam2.__file__).resolve() != (source / "sam2" / "__init__.py").resolve():
        raise RuntimeError("SAM2 imported from an unexpected path")
    return {
        "importsAvailable": True,
        "sam2ImportedFrom": str(sam2.__file__),
        "torchVersion": torch.__version__,
        "importsMs": round((time.perf_counter() - import_started) * 1000, 3),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--site", type=Path, default=DEFAULT_SITE)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--health", action="store_true")
    exit_code = 0
    try:
        # Capture even third-party import/model prints to protect the JSON protocol.
        with contextlib.redirect_stdout(sys.stderr):
            args = parser.parse_args()
            if not 1 <= args.threads <= 64:
                raise ValueError("threads must be between 1 and 64")
            if args.health:
                result = health(args.site.resolve(), args.source.resolve())
            else:
                request = json.loads(sys.stdin.read())
                result = segment(
                    request,
                    args.checkpoint.resolve(),
                    args.site.resolve(),
                    args.source.resolve(),
                    args.config,
                    args.threads,
                )
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        result = {"ok": False, "error": {"type": type(exc).__name__, "message": str(exc)}}
        exit_code = 1
    print(json.dumps(result, ensure_ascii=True, allow_nan=False), flush=True)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
