"""Frozen SAM2.1 candidate selection experiment. No product integration or mask repair."""
import argparse
from collections import deque
import hashlib
import inspect
import json
import os
from pathlib import Path
import sys
import time
import traceback

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.environ["SAM2_BUILD_CUDA"] = "0"
ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / ".data/ui-samples"
VENDOR = ROOT / ".data/segmentation/sam2"
POINTS = SAMPLES / "benchmark-20261028-visual-retry-config01/points.json"
BASELINE = SAMPLES / "benchmark-sam2-20261028-full01/report.json"
RULE_VERSION = "v1-frozen-no-revision"


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def component_metrics(crop):
    """Four-connected foreground in the actual client crop; no filtering of the output."""
    import numpy as np
    remaining = crop.copy()
    height, width = crop.shape
    sizes = []
    for y, x in zip(*np.nonzero(crop)):
        if not remaining[y, x]:
            continue
        remaining[y, x] = False
        queue = deque([(int(y), int(x))])
        size = 0
        while queue:
            row, col = queue.popleft()
            size += 1
            for next_y, next_x in ((row-1, col), (row+1, col), (row, col-1), (row, col+1)):
                if 0 <= next_y < height and 0 <= next_x < width and remaining[next_y, next_x]:
                    remaining[next_y, next_x] = False
                    queue.append((next_y, next_x))
        sizes.append(size)
    total = sum(sizes)
    return len(sizes), max(sizes, default=0) / max(total, 1)


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
        margins = [cols.min()/width, (width-1-cols.max())/width,
                   rows.min()/height, (height-1-rows.max())/height]
        alignment = float(np.mean([max(0.0, 1.0-4.0*gap) for gap in margins]))
    # A relative 3% interior band tolerates an approximate prompt; each edge has equal weight.
    band_x, band_y = max(1, round(width*0.03)), max(1, round(height*0.03))
    edge_support = [float(crop[:, :band_x].mean()), float(crop[:, -band_x:].mean()),
                    float(crop[:band_y, :].mean()), float(crop[-band_y:, :].mean())]
    components, largest_share = component_metrics(crop)
    point_matches = [bool(mask[p["y"], p["x"]]) == bool(p["label"]) for p in points]
    return {"modelScore": float(score), "scoreIsMeasuredIou": False,
            "insidePixels": inside, "outsidePixelsDiagnosticOnly": total-inside,
            "bboxCoverageDiagnosticOnly": inside/crop.size, "extentAlignment": alignment,
            "edgeSupport": edge_support, "meanEdgeSupport": sum(edge_support)/4,
            "componentCountInCrop": components, "largestComponentShare": largest_share,
            "fragmentShare": 1.0-largest_share,
            "outsideFraction": (total-inside)/max(total, 1),
            "pointMatches": point_matches,
            "pointAgreement": sum(point_matches)/len(points) if points else None}


def select_candidate(masks, scores, box, points, kind):
    """Copy this plus candidate_metrics/component_metrics; receives no sample IDs or truth.

    Returns the original candidate index and auditable metrics. Never modifies masks.
    Model score is a model estimate, not measured IoU. Ties favor the smaller index.
    """
    import numpy as np
    masks = np.asarray(masks)
    scores = np.asarray(scores)
    if masks.ndim != 3 or len(masks) == 0 or scores.shape != (len(masks),):
        raise ValueError("expected N full-image masks and N scores")
    if not np.all((masks == 0) | (masks == 1)) or not np.isfinite(scores).all():
        raise ValueError("masks must be binary and scores finite")
    x0, y0, x1, y1 = box
    height, width = masks.shape[1:]
    if not all(type(v) is int for v in box) or not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ValueError("bbox must be integer exclusive bounds within the original image")
    for point in points:
        if (type(point["x"]) is not int or type(point["y"]) is not int or
                not (0 <= point["x"] < width and 0 <= point["y"] < height) or point["label"] not in (0, 1)):
            raise ValueError("invalid original-image point")
    records = []
    whole_control = kind in ("panel", "button")
    for index, mask in enumerate(masks):
        metrics = candidate_metrics(mask.astype(bool), scores[index], box, points)
        score = float(np.clip(scores[index], 0, 1))
        outside_penalty = min(metrics["outsideFraction"], 0.5)
        if whole_control:
            # Saturation avoids preferring a filled rectangle solely for its extra pixels.
            coverage_support = min(metrics["bboxCoverageDiagnosticOnly"] / 0.85, 1.0)
            terms = {"score": 0.30*score, "extent": 0.30*metrics["extentAlignment"],
                     "edge": 0.25*metrics["meanEdgeSupport"], "coverageCapped": 0.10*coverage_support,
                     "connected": 0.05*metrics["largestComponentShare"],
                     "outside": -0.08*outside_penalty, "fragment": -0.10*metrics["fragmentShare"]}
        else:
            terms = {"score": 0.80*score, "connected": 0.10*metrics["largestComponentShare"],
                     "extent": 0.10*metrics["extentAlignment"],
                     "outside": -0.15*outside_penalty, "fragment": -0.15*metrics["fragmentShare"]}
        terms["points"] = 2.0*metrics["pointAgreement"] if points else 0.0
        rank = sum(terms.values())
        records.append({"index": index, "metrics": metrics, "rankTerms": terms, "rank": rank})
    chosen = max(range(len(records)), key=lambda index: (records[index]["rank"], -index))
    branch = "whole-control" if whole_control else "conservative"
    reason = (f"{RULE_VERSION}; kind={kind}; branch={branch}; max composite rank; "
              f"chosen={chosen}; ranks=" + ",".join(f"{r['rank']:.6f}" for r in records) +
              "; tie=lower index; no mask edits; outside area is not a failure verdict")
    return chosen, records, reason


def selector_self_check():
    import numpy as np
    masks = np.zeros((3, 20, 20), dtype=bool)
    masks[0, 6:14, 6:14] = True
    masks[1, 2:18, 2:18] = True
    masks[2, 2:18, 2:18] = True
    # Thin complete border versus nested content, equal-mask deterministic tie, and point rejection.
    chosen, _, _ = select_candidate(masks, [0.95, 0.88, 0.88], [2, 2, 18, 18], [], "panel")
    assert chosen == 1
    # Independent arithmetic: nested mask has zero extent alignment, full mask has one.
    # The original 0.95/0.88 scores give 0.860/0.904, correctly choosing the full mask.
    original_choice, original_records, _ = select_candidate(
        masks, [0.95, 0.88, 0.88], [2, 2, 18, 18], [], "icon")
    assert original_choice == 1
    assert np.allclose([r["rank"] for r in original_records], [0.860, 0.904, 0.904], rtol=0, atol=1e-12)
    chosen, conservative_records, _ = select_candidate(masks, [0.99, 0.75, 0.75], [2, 2, 18, 18], [], "icon")
    assert np.allclose([r["rank"] for r in conservative_records], [0.892, 0.800, 0.800], rtol=0, atol=1e-12)
    assert chosen == 0  # Conservative branch does not simply choose maximum area.
    chosen, _, _ = select_candidate(masks, [0.99, 0.8, 0.8], [2, 2, 18, 18],
                                     [{"x": 3, "y": 3, "label": 1}], "icon")
    assert chosen == 1
    assert masks.sum() == 576


def protected_snapshot():
    # The experiment never writes venv/vendor. Protect product, inputs and prior evidence.
    folders = [ROOT / name for name in ("src", "server")]
    folders.extend([BASELINE.parent, SAMPLES / "benchmark-hq-20261028-paired01",
                    POINTS.parent])
    paths = [p for folder in folders for p in folder.rglob("*") if p.is_file()]
    paths.extend([SAMPLES / "source.json", ROOT / "scripts/segment.py",
                  ROOT / "scripts/segment-sam2-benchmark.py", VENDOR / "sam2.1_hiera_small.pt",
                  VENDOR / "official-manifest.json",
                  VENDOR / "source/sam2/configs/sam2.1/sam2.1_hiera_s.yaml"])
    manifest = json.loads((SAMPLES / "source.json").read_text(encoding="utf-8"))
    paths.extend(Path(sample["original_path"]) for sample in manifest["samples"])
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted(paths)}


def save_candidate(original, mask, directory, name, box):
    import numpy as np
    from PIL import Image
    rgba = original.copy()
    rgba[:, :, 3] = np.where(mask, original[:, :, 3], 0)
    paths = {"maskPath": directory / (name+"-mask.png"),
             "rgbaPath": directory / (name+"-rgba.png"),
             "finalBboxRgbaPath": directory / (name+"-bbox-rgba.png")}
    Image.fromarray(mask.astype(np.uint8)*255).save(paths["maskPath"])
    Image.fromarray(rgba).save(paths["rgbaPath"])
    Image.fromarray(rgba).crop(box).save(paths["finalBboxRgbaPath"])
    with Image.open(paths["rgbaPath"]) as loaded:
        saved = np.array(loaded)
    with Image.open(paths["finalBboxRgbaPath"]) as loaded:
        crop = np.array(loaded)
    with Image.open(paths["maskPath"]) as loaded:
        saved_mask = np.array(loaded)
    x0, y0, x1, y1 = box
    assert np.array_equal(saved[:, :, :3], original[:, :, :3])
    assert np.array_equal(saved[:, :, 3], np.where(mask, original[:, :, 3], 0))
    assert np.array_equal(saved_mask, mask.astype(np.uint8)*255)
    assert np.array_equal(crop, saved[y0:y1, x0:x1])
    result = {key: str(path) for key, path in paths.items()}
    result["sha256"] = {key: sha(path) for key, path in paths.items()}
    result["checks"] = {"sourceRgb": True, "sourceAlphaTimesMask": True,
                        "binaryMaskRoundtrip": True, "exactClientBboxCrop": True}
    return result


def comparison(source, box, points, baseline, candidates, chosen, directory, title):
    import numpy as np
    from PIL import Image, ImageDraw
    annotated = source.convert("RGB").copy()
    draw = ImageDraw.Draw(annotated)
    for point in points:
        x, y = point["x"], point["y"]
        draw.ellipse((x-2, y-2, x+2, y+2), fill="lime" if point["label"] else "red")
    panels = [(annotated.crop(box), "SOURCE exact client bbox")]
    for name in ("mobile", "hq", "sam2"):
        panels.append((Image.open(baseline["models"][name]["finalBboxRgbaPath"]).convert("RGBA"), name+" BASELINE"))
    for candidate in candidates:
        panels.append((Image.open(candidate["finalBboxRgbaPath"]).convert("RGBA"),
                       f"C{candidate['index']} rank={candidate['rank']:.4f} score={candidate['metrics']['modelScore']:.4f}"))
    panels.append((Image.open(candidates[chosen]["finalBboxRgbaPath"]).convert("RGBA"), f"AUTO CHOSEN C{chosen}"))
    tile = Image.new("RGB", (1440, 560), "#202530")
    draw = ImageDraw.Draw(tile)
    draw.text((8, 4), title, fill="white")
    for index, (panel, label) in enumerate(panels):
        col, row = index % 4, index // 4
        x, y = col*360, 28+row*264
        draw.text((x+6, y), label, fill="yellow" if index == 7 else "white")
        panel = panel.convert("RGBA")
        yy, xx = np.indices((panel.height, panel.width))
        gray = np.where((xx//8+yy//8) % 2, 240, 175).astype(np.uint8)
        checker = Image.fromarray(np.repeat(gray[:, :, None], 3, axis=2)).convert("RGBA")
        view = Image.alpha_composite(checker, panel).convert("RGB")
        scale = min(348/view.width, 228/view.height, 10)
        size = (max(1, round(view.width*scale)), max(1, round(view.height*scale)))
        tile.paste(view.resize(size, Image.Resampling.NEAREST), (x+(360-size[0])//2, y+24+(228-size[1])//2))
    tile.save(directory / "comparison.png")
    return tile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    args = parser.parse_args()
    run = args.run_dir.resolve()
    if run.parent != SAMPLES or not run.name.startswith("benchmark-candidates-"):
        raise ValueError("use a new .data/ui-samples/benchmark-candidates-* directory")
    run.mkdir(exist_ok=False)
    manifest = json.loads((SAMPLES / "source.json").read_text(encoding="utf-8"))
    targets = [s["id"]+"/"+t["id"] for s in manifest["samples"] for t in s["targets"]]
    holdout = targets[3::4]
    assert len(targets) == 20 and len(holdout) == 5
    selector = "\n\n".join(inspect.getsource(fn) for fn in (component_metrics, candidate_metrics, select_candidate))
    # Written before model import, inference, or access to any output from this run.
    (run / "selection-function.py.txt").write_text(
        "from collections import deque\nRULE_VERSION = " + repr(RULE_VERSION) + "\n\n" + selector,
        encoding="utf-8")
    freeze = {"ruleVersion": RULE_VERSION, "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "scriptSha256": sha(__file__), "selectorSha256": sha(run / "selection-function.py.txt"),
              "holdoutIds": holdout, "holdoutMethod": "every fourth target in unchanged source manifest",
              "revisionBudget": 1, "revisionsUsed": 0, "noOutputViewedBeforeFreeze": True,
              "truthUsed": False, "sourceSha256": sha(SAMPLES / "source.json"),
              "pointsSha256": sha(POINTS), "baselineReportSha256": sha(BASELINE)}
    write_json(run / "rule-freeze.json", freeze)
    start = time.perf_counter()
    before = protected_snapshot()
    write_json(run / "protected-before.json", before)
    report = {"rule": freeze, "results": [], "images": [], "exceptions": [], "groundTruth": None,
              "measuredIou": None, "qualityPassRate": None, "multimaskOutput": True,
              "device": "cpu", "dtype": "float32", "threads": 4,
              "maskPostprocessing": "none; no fill, union, clipping, or cleanup",
              "timingScope": "offline predict only; not product API latency"}
    try:
        import numpy as np
        from PIL import Image
        import torch
        selector_self_check()
        report["selectorSelfChecks"] = True
        torch.set_num_threads(4)
        sys.path.insert(0, str(VENDOR / "site"))
        sys.path.insert(0, str(VENDOR / "source"))
        import sam2
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        assert Path(sam2.__file__).resolve() == VENDOR / "source/sam2/__init__.py"
        assert torch.__version__ == "2.8.0+cpu" and torch.version.cuda is None
        checkpoint = VENDOR / "sam2.1_hiera_small.pt"
        assert sha(checkpoint) == "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38"
        report["sam2ImportedFrom"] = sam2.__file__
        load_start = time.perf_counter()
        model = build_sam2("configs/sam2.1/sam2.1_hiera_s.yaml", str(checkpoint),
                           device="cpu", mode="eval", apply_postprocessing=False)
        assert all(p.device.type == "cpu" and p.dtype == torch.float32 for p in model.parameters())
        predictor = SAM2ImagePredictor(model, mask_threshold=0.0, max_hole_area=0.0, max_sprinkle_area=0.0)
        report["modelLoadMs"] = (time.perf_counter()-load_start)*1000
        print(json.dumps({"modelLoaded": True, "rule": RULE_VERSION}), flush=True)
        previous = json.loads(BASELINE.read_text(encoding="utf-8"))
        baselines = {(r["id"], r["mode"]): r for r in previous["results"]}
        retry = json.loads(POINTS.read_text(encoding="utf-8"))
        with torch.inference_mode():
            for sample in manifest["samples"]:
                path = Path(sample["original_path"])
                assert sha(path) == sample["sha256"]
                with Image.open(path) as loaded:
                    source = loaded.convert("RGBA")
                original = np.array(source)
                encode_start = time.perf_counter()
                predictor.set_image(np.array(source.convert("RGB"), copy=True))
                report["images"].append({"id": sample["id"], "encodeMs": (time.perf_counter()-encode_start)*1000})
                tiles = []
                for target in sample["targets"]:
                    key = sample["id"]+"/"+target["id"]
                    modes = [("bbox", [])]
                    if key in retry:
                        modes.append(("points", retry[key]["points"]))
                    for mode, points in modes:
                        box = target["bbox_xyxy"]
                        request = {"imagePath": str(path), "bbox": box, "points": points}
                        baseline = baselines[(key, mode)]
                        assert request == baseline["request"]
                        for previous_model in baseline["models"].values():
                            assert sha(previous_model["maskPath"]) == previous_model["maskSha256"]
                        directory = run / sample["id"] / (target["id"]+"-"+mode)
                        directory.mkdir(parents=True)
                        write_json(directory / "request.json", request)
                        predict_start = time.perf_counter()
                        masks, scores, _ = predictor.predict(
                            box=np.asarray(box, dtype=np.float32), multimask_output=True,
                            point_coords=np.asarray([[p["x"], p["y"]] for p in points], dtype=np.float32) if points else None,
                            point_labels=np.asarray([p["label"] for p in points], dtype=np.int32) if points else None)
                        predict_ms = (time.perf_counter()-predict_start)*1000
                        assert masks.shape == (3, source.height, source.width)
                        chosen, candidates, reason = select_candidate(masks, scores, box, points, target["kind"])
                        for candidate, mask in zip(candidates, masks):
                            candidate.update(save_candidate(original, mask.astype(bool), directory,
                                                            "candidate-"+str(candidate["index"]), box))
                        chosen_paths = save_candidate(original, masks[chosen].astype(bool), directory, "chosen", box)
                        assert chosen_paths["sha256"] == candidates[chosen]["sha256"]
                        record = {"id": key, "kind": target["kind"], "mode": mode,
                                  "heldOut": key in holdout, "request": request, "predictMs": predict_ms,
                                  "candidates": candidates, "chosenIndex": chosen, "reason": reason,
                                  "chosen": chosen_paths, "baseline": baseline["models"],
                                  "comparisonPath": str(directory / "comparison.png")}
                        tiles.append(comparison(source, box, points, baseline, candidates, chosen, directory,
                                                key+" / "+mode+" / "+target["kind"]+" / "+("HOLDOUT" if key in holdout else "development")))
                        write_json(directory / "metadata.json", record)
                        report["results"].append(record)
                        write_json(run / "report.json", report)
                        print(json.dumps({"id": key, "mode": mode, "chosen": chosen,
                                          "predictMs": round(predict_ms, 2), "candidates": 3}), flush=True)
                sheet = Image.new("RGB", (1440, 560*len(tiles)), "#202530")
                for index, tile in enumerate(tiles):
                    sheet.paste(tile, (0, 560*index))
                sheet.save(run / (sample["id"]+"-contact.png"))
        assert len(report["results"]) == 22
        assert sum(len(r["candidates"]) for r in report["results"]) == 66
        report["successCount"] = 22
    except Exception as exc:
        report["exceptions"].append({"type": type(exc).__name__, "message": str(exc)})
        (run / "exception.txt").write_text(traceback.format_exc(), encoding="utf-8")
        traceback.print_exc()
    finally:
        after = protected_snapshot()
        write_json(run / "protected-after.json", after)
        changes = [key for key in sorted(before.keys() | after.keys()) if before.get(key) != after.get(key)]
        report["protectedChangedPaths"] = changes
        report["protectedFilesUnchanged"] = not changes
        report["protectedFileCount"] = len(before)
        report["wallSecondsIncludingVerification"] = time.perf_counter()-start
        write_json(run / "report.json", report)
    print(json.dumps({"report": str(run / "report.json"), "success": report.get("successCount", 0),
                      "exceptions": report["exceptions"], "protectedChanges": report["protectedChangedPaths"]}), flush=True)
    return 0 if report.get("successCount") and not report["exceptions"] else 1


if __name__ == "__main__":
    sys.exit(main())
