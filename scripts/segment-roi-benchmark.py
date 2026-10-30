"""Fixed roi-context-v1 experiment; existing model, selector and baselines stay read-only."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import runpy
import sys
import time
import traceback

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.environ["SAM2_BUILD_CUDA"] = "0"
ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / ".data/ui-samples"
VENDOR = ROOT / ".data/segmentation/sam2"
PREVIOUS = SAMPLES / "benchmark-candidates-20261028-full02"
SINGLE = SAMPLES / "benchmark-sam2-20261028-full01/report.json"
POINTS = SAMPLES / "benchmark-20261028-visual-retry-config01/points.json"
RULE = "roi-context-v1"
SMOKE = {"wesnoth/minimap", "openttd-settings/language", "supertuxkart/minimap",
         "supertuxkart/speedometer", "wesnoth/menu", "wesnoth/end-turn",
         "openttd-windows/finances", "openttd-multiplayer/dialog"}


def roi_prompt(box, points, width, height):
    padding = max(16, math.ceil(0.30*max(box[2]-box[0], box[3]-box[1])))
    # Points denote pixels; +1 preserves the maximum point under exclusive bounds.
    left = min([box[0]]+[p["x"] for p in points])
    top = min([box[1]]+[p["y"] for p in points])
    right = max([box[2]]+[p["x"]+1 for p in points])
    bottom = max([box[3]]+[p["y"]+1 for p in points])
    roi = [max(0, left-padding), max(0, top-padding),
           min(width, right+padding), min(height, bottom+padding)]
    x0, y0, x1, y1 = roi
    local_box = [box[0]-x0, box[1]-y0, box[2]-x0, box[3]-y0]
    local_points = [{"x": p["x"]-x0, "y": p["y"]-y0, "label": p["label"]} for p in points]
    assert all(0 <= p["x"] < x1-x0 and 0 <= p["y"] < y1-y0 for p in local_points)
    assert [local_box[0]+x0, local_box[1]+y0, local_box[2]+x0, local_box[3]+y0] == box
    assert [{"x": p["x"]+x0, "y": p["y"]+y0, "label": p["label"]} for p in local_points] == points
    return {"padding": padding, "roiXyxy": roi, "localBbox": local_box,
            "localPoints": local_points, "offsetXy": [x0, y0], "maskMapping": "translation only; outside ROI zero"}


def map_mask(local, roi, width, height):
    import numpy as np
    x0, y0, x1, y1 = roi
    assert local.shape == (y1-y0, x1-x0)
    assert np.all((local == 0) | (local == 1))
    mapped = np.zeros((height, width), dtype=bool)
    mapped[y0:y1, x0:x1] = local.astype(bool)
    assert np.array_equal(mapped[y0:y1, x0:x1], local.astype(bool))
    assert int(mapped.sum()) == int(local.sum())
    return mapped


def mapping_self_check():
    import numpy as np
    result = roi_prompt([40, 40, 60, 50], [], 100, 80)
    assert result["padding"] == 16 and result["roiXyxy"] == [24, 24, 76, 66]
    result = roi_prompt([40, 40, 60, 50], [{"x": 90, "y": 5, "label": 0}], 100, 80)
    assert result["roiXyxy"] == [24, 0, 100, 66]
    assert result["localPoints"] == [{"x": 66, "y": 5, "label": 0}]
    assert roi_prompt([0, 0, 5, 5], [], 100, 80)["roiXyxy"] == [0, 0, 21, 21]
    local = np.zeros((3, 4), dtype=bool)
    local[1, 2] = True
    mapped = map_mask(local, [5, 7, 9, 10], 20, 20)
    assert int(mapped.sum()) == 1 and mapped[8, 7]


def protected_snapshot(sha):
    paths = [p for name in ("src", "server") for p in (ROOT/name).rglob("*") if p.is_file()]
    paths.extend([ROOT/"scripts/segment.py", ROOT/"scripts/segment-candidate-benchmark.py",
                  SAMPLES/"source.json", POINTS, VENDOR/"sam2.1_hiera_small.pt",
                  VENDOR/"source/sam2/sam2_image_predictor.py", VENDOR/"source/sam2/utils/transforms.py",
                  VENDOR/"source/sam2/configs/sam2.1/sam2.1_hiera_s.yaml"])
    for folder in (PREVIOUS, SINGLE.parent):
        paths.extend(p for p in folder.rglob("*") if p.is_file())
    manifest = json.loads((SAMPLES/"source.json").read_text(encoding="utf-8"))
    paths.extend(Path(s["original_path"]) for s in manifest["samples"])
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted(paths)}


def comparison(source, box, full_single, full_auto, single, candidates, chosen, directory, title):
    import numpy as np
    from PIL import Image, ImageDraw
    panels = [(source.crop(box), "SOURCE actual bbox (not a result)"),
              (Image.open(full_single["finalBboxRgbaPath"]), "FULL input single baseline"),
              (Image.open(full_auto["chosen"]["finalBboxRgbaPath"]), "FULL input auto C"+str(full_auto["chosenIndex"])),
              (Image.open(single["finalBboxRgbaPath"]), "ROI input SINGLE")]
    for candidate in candidates:
        panels.append((Image.open(candidate["finalBboxRgbaPath"]),
                       f"ROI C{candidate['index']} rank={candidate['rank']:.4f} score={candidate['metrics']['modelScore']:.4f}"))
    panels.append((Image.open(candidates[chosen]["finalBboxRgbaPath"]), "ROI AUTO CHOSEN C"+str(chosen)))
    tile = Image.new("RGB", (1440, 560), "#202530")
    draw = ImageDraw.Draw(tile)
    draw.text((8, 4), title, fill="white")
    for index, (panel, label) in enumerate(panels):
        x, y = index % 4*360, 28+index//4*264
        draw.text((x+6, y), label, fill="yellow" if index == 7 else "white")
        panel = panel.convert("RGBA")
        yy, xx = np.indices((panel.height, panel.width))
        gray = np.where((xx//8+yy//8) % 2, 240, 175).astype(np.uint8)
        checker = Image.fromarray(np.repeat(gray[:, :, None], 3, axis=2)).convert("RGBA")
        view = Image.alpha_composite(checker, panel).convert("RGB")
        scale = min(348/view.width, 228/view.height, 10)
        size = (max(1, round(view.width*scale)), max(1, round(view.height*scale)))
        tile.paste(view.resize(size, Image.Resampling.NEAREST), (x+(360-size[0])//2, y+24+(228-size[1])//2))
    tile.save(directory/"comparison.png")
    return tile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--stage", choices=("smoke", "full"), required=True)
    args = parser.parse_args()
    run = args.run_dir.resolve()
    if run.parent != SAMPLES or not run.name.startswith("benchmark-roi-"):
        raise ValueError("use a new benchmark-roi-* directory")
    run.mkdir(exist_ok=False)
    helpers = runpy.run_path(str(ROOT/"scripts/segment-candidate-benchmark.py"))
    sha, write_json, save_candidate = (helpers[name] for name in ("sha", "write_json", "save_candidate"))
    selector_path = PREVIOUS/"selection-function.py.txt"
    assert sha(selector_path) == "292f10d67abd512004fe5fdab881797042e398937d7a71df37cc2a92c619adb3"
    selector_text = selector_path.read_text(encoding="utf-8")
    selector_scope = {}
    exec(selector_text, selector_scope)
    select_candidate = selector_scope["select_candidate"]
    (run/"selection-function.py.txt").write_text(selector_text, encoding="utf-8")
    (run/"executed-script.py.txt").write_text(Path(__file__).read_text(encoding="utf-8"), encoding="utf-8")
    manifest = json.loads((SAMPLES/"source.json").read_text(encoding="utf-8"))
    retry = json.loads(POINTS.read_text(encoding="utf-8"))
    old = json.loads((PREVIOUS/"report.json").read_text(encoding="utf-8"))
    full_auto = {(r["id"], r["mode"]): r for r in old["results"]}
    old_single = json.loads(SINGLE.read_text(encoding="utf-8"))
    full_single = {(r["id"], r["mode"]): r["models"]["sam2"] for r in old_single["results"]}
    jobs = []
    for sample in manifest["samples"]:
        for target in sample["targets"]:
            key = sample["id"]+"/"+target["id"]
            if args.stage == "smoke" and key not in SMOKE:
                continue
            modes = [("bbox", [])]
            if args.stage == "full" and key in retry:
                modes.append(("points", retry[key]["points"]))
            for mode, points in modes:
                transform = roi_prompt(target["bbox_xyxy"], points, sample["width"], sample["height"])
                jobs.append({"id": key, "mode": mode, "sample": sample, "target": target,
                             "points": points, "transform": transform})
    freeze = {"rule": RULE, "createdUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "stage": args.stage, "scriptSha256": sha(__file__), "selectorSha256": sha(selector_path),
              "sourceSha256": sha(SAMPLES/"source.json"), "pointsSha256": sha(POINTS),
              "paddingFormula": "max(16,ceil(0.30*max(original_bbox_width,original_bbox_height)))",
              "pointsPolicy": "union original bbox and all point pixels first; same original-bbox padding; clip to source",
              "selectorWeightChanges": 0, "roiRuleRevisions": 0, "jobs": jobs}
    write_json(run/"rule-freeze.json", freeze)
    before = protected_snapshot(sha)
    write_json(run/"protected-before.json", before)
    report = {"rule": RULE, "stage": args.stage, "results": [], "exceptions": [],
              "groundTruth": None, "measuredIou": None, "qualityPassRate": None,
              "device": "cpu", "dtype": "float32", "threads": 4, "selectorSha256": sha(selector_path),
              "venvBoundary": "not modified; no full venv hash scan", "postprocessing": False}
    start = time.perf_counter()
    try:
        import numpy as np
        from PIL import Image, ImageDraw
        import torch
        mapping_self_check()
        report["mappingSelfCheck"] = True
        torch.set_num_threads(4)
        sys.path.insert(0, str(VENDOR/"site"))
        sys.path.insert(0, str(VENDOR/"source"))
        import sam2
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        assert Path(sam2.__file__).resolve() == VENDOR/"source/sam2/__init__.py"
        assert torch.__version__ == "2.8.0+cpu" and torch.version.cuda is None
        checkpoint = VENDOR/"sam2.1_hiera_small.pt"
        assert sha(checkpoint) == "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38"
        load_start = time.perf_counter()
        model = build_sam2("configs/sam2.1/sam2.1_hiera_s.yaml", str(checkpoint),
                           device="cpu", mode="eval", apply_postprocessing=False)
        predictor = SAM2ImagePredictor(model, mask_threshold=0.0, max_hole_area=0.0, max_sprinkle_area=0.0)
        assert model.image_size == 1024
        report["modelLoadMs"] = (time.perf_counter()-load_start)*1000
        print(json.dumps({"modelLoaded": True, "jobs": len(jobs), "rule": RULE}), flush=True)
        tiles_by_sample = {}
        with torch.inference_mode():
            for job in jobs:
                sample, target = job["sample"], job["target"]
                key, mode, points = job["id"], job["mode"], job["points"]
                box = target["bbox_xyxy"]
                path = Path(sample["original_path"])
                assert sha(path) == sample["sha256"]
                with Image.open(path) as loaded:
                    source = loaded.convert("RGBA")
                original = np.array(source)
                transform = job["transform"]
                rx0, ry0, rx1, ry1 = transform["roiXyxy"]
                roi_rgb = np.array(source.convert("RGB").crop(transform["roiXyxy"]), copy=True)
                assert np.array_equal(roi_rgb, original[ry0:ry1, rx0:rx1, :3])
                directory = run/sample["id"]/(target["id"]+"-"+mode)
                directory.mkdir(parents=True)
                Image.fromarray(roi_rgb).save(directory/"roi-input-rgb.png")
                assert np.array_equal(np.array(Image.open(directory/"roi-input-rgb.png")), roi_rgb)
                context = Image.fromarray(roi_rgb)
                draw = ImageDraw.Draw(context)
                draw.rectangle(transform["localBbox"], outline="yellow", width=1)
                for point in transform["localPoints"]:
                    x, y = point["x"], point["y"]
                    draw.ellipse((x-2, y-2, x+2, y+2), fill="lime" if point["label"] else "red")
                context.save(directory/"roi-context-preview.png")
                request = {"imagePath": str(path), "bbox": box, "points": points}
                assert request == full_auto[(key, mode)]["request"]
                transform["fullInputBboxAtEncoderXy"] = [(box[2]-box[0])*1024/source.width, (box[3]-box[1])*1024/source.height]
                transform["roiInputBboxAtEncoderXy"] = [(box[2]-box[0])*1024/(rx1-rx0), (box[3]-box[1])*1024/(ry1-ry0)]
                write_json(directory/"request.json", {"original": request, "transform": transform})
                encode_start = time.perf_counter()
                predictor.set_image(roi_rgb)
                encode_ms = (time.perf_counter()-encode_start)*1000
                local_points = transform["localPoints"]
                predict_args = {"box": np.asarray(transform["localBbox"], dtype=np.float32),
                                "point_coords": np.asarray([[p["x"], p["y"]] for p in local_points], dtype=np.float32) if local_points else None,
                                "point_labels": np.asarray([p["label"] for p in local_points], dtype=np.int32) if local_points else None}
                predict_start = time.perf_counter()
                single_masks, single_scores, _ = predictor.predict(**predict_args, multimask_output=False)
                single_ms = (time.perf_counter()-predict_start)*1000
                predict_start = time.perf_counter()
                local_masks, scores, _ = predictor.predict(**predict_args, multimask_output=True)
                multi_ms = (time.perf_counter()-predict_start)*1000
                assert single_masks.shape == (1, ry1-ry0, rx1-rx0)
                assert local_masks.shape == (3, ry1-ry0, rx1-rx0)
                mapped_single = map_mask(single_masks[0], transform["roiXyxy"], source.width, source.height)
                mapped = np.stack([map_mask(mask, transform["roiXyxy"], source.width, source.height) for mask in local_masks])
                chosen, candidates, reason = select_candidate(mapped, scores, box, points, target["kind"])
                single = save_candidate(original, mapped_single, directory, "single", box)
                single["score"] = float(single_scores[0])
                single["metrics"] = selector_scope["candidate_metrics"](mapped_single, single_scores[0], box, points)
                Image.fromarray(single_masks[0].astype(np.uint8)*255).save(directory/"single-roi-mask.png")
                for candidate, local_mask, mask in zip(candidates, local_masks, mapped):
                    name = "candidate-"+str(candidate["index"])
                    candidate.update(save_candidate(original, mask, directory, name, box))
                    local_path = directory/(name+"-roi-mask.png")
                    Image.fromarray(local_mask.astype(np.uint8)*255).save(local_path)
                    candidate["roiMaskPath"] = str(local_path)
                    candidate["roiMaskSha256"] = sha(local_path)
                chosen_files = save_candidate(original, mapped[chosen], directory, "chosen", box)
                assert chosen_files["sha256"] == candidates[chosen]["sha256"]
                record = {"id": key, "mode": mode, "kind": target["kind"], "request": request,
                          "transform": transform, "encodeMs": encode_ms, "singlePredictMs": single_ms,
                          "multiPredictMs": multi_ms, "single": single, "candidates": candidates,
                          "chosenIndex": chosen, "chosen": chosen_files, "reason": reason,
                          "fullImageSingle": full_single[(key, mode)], "fullImageAuto": full_auto[(key, mode)],
                          "checks": {"roiInputRgbExact": True, "allPointsRetained": True,
                                     "officialReturnedRoiSize": True, "mappingExactNoResize": True,
                                     "outsideRoiZero": True, "sourceRgbAlphaAndClientCrop": True}}
                tile = comparison(source, box, full_single[(key, mode)], full_auto[(key, mode)],
                                  single, candidates, chosen, directory, key+" / "+mode+" / "+RULE)
                tiles_by_sample.setdefault(sample["id"], []).append(tile)
                write_json(directory/"metadata.json", record)
                report["results"].append(record)
                write_json(run/"report.json", report)
                print(json.dumps({"id": key, "mode": mode, "roi": transform["roiXyxy"],
                                  "chosen": chosen, "encodeMs": round(encode_ms, 2),
                                  "multiMs": round(multi_ms, 2)}), flush=True)
        for sample_id, tiles in tiles_by_sample.items():
            sheet = Image.new("RGB", (1440, 560*len(tiles)), "#202530")
            for index, tile in enumerate(tiles):
                sheet.paste(tile, (0, 560*index))
            sheet.save(run/(sample_id+"-contact.png"))
        expected = 8 if args.stage == "smoke" else 22
        assert len(report["results"]) == expected
        report["successCount"] = expected
    except Exception as exc:
        report["exceptions"].append({"type": type(exc).__name__, "message": str(exc)})
        (run/"exception.txt").write_text(traceback.format_exc(), encoding="utf-8")
        traceback.print_exc()
    finally:
        after = protected_snapshot(sha)
        write_json(run/"protected-after.json", after)
        report["protectedChangedPaths"] = [key for key in before.keys() | after.keys() if before.get(key) != after.get(key)]
        report["protectedFilesUnchanged"] = before == after
        report["protectedFileCount"] = len(before)
        report["wallSeconds"] = time.perf_counter()-start
        write_json(run/"report.json", report)
    print(json.dumps({"report": str(run/"report.json"), "success": report.get("successCount", 0),
                      "exceptions": report["exceptions"], "protectedChanges": report["protectedChangedPaths"]}), flush=True)
    return 0 if report.get("successCount") and not report["exceptions"] else 1


if __name__ == "__main__":
    sys.exit(main())
