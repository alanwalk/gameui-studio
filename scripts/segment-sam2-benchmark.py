"""Independent frozen Meta SAM2.1 small CPU experiment; existing baselines are read-only."""
import argparse
import hashlib
import importlib.metadata
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
BASE = ROOT / ".data/segmentation/sam2"
SAMPLES = ROOT / ".data/ui-samples"
POINTS = SAMPLES / "benchmark-20261028-visual-retry-config01/points.json"
HQ_REPORT = SAMPLES / "benchmark-hq-20261028-paired01/report.json"
SMOKE = {"wesnoth/minimap", "openttd-settings/language", "supertuxkart/minimap",
         "supertuxkart/speedometer", "wesnoth/menu", "wesnoth/end-turn",
         "openttd-windows/finances", "openttd-multiplayer/dialog"}


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def protected_snapshot():
    paths = [p for folder in (".venv-seg", "src", "server", "dist")
             for p in (ROOT / folder).rglob("*") if p.is_file()]
    paths.extend([SAMPLES / "source.json", POINTS, HQ_REPORT, ROOT / "scripts/segment.py"])
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted(paths)}


def comparison(source, box, points, models, directory, title):
    import numpy as np
    from PIL import Image, ImageDraw

    original = source.convert("RGB")
    annotated = original.copy()
    draw = ImageDraw.Draw(annotated)
    draw.rectangle(box, outline="#ffcc00", width=2)
    for point in points:
        x, y = point["x"], point["y"]
        color = "#00ff80" if point["label"] else "#ff3040"
        draw.ellipse((x-3, y-3, x+3, y+3), fill=color)
    panels = [(annotated.crop(box), "SOURCE exact bbox")]
    for name, record in models.items():
        with Image.open(record["maskPath"]) as mask:
            panels.append((mask.crop(box).convert("RGB"), name + " MASK exact bbox"))
    panels.append((annotated, "SOURCE full image / bbox"))
    for name, record in models.items():
        with Image.open(record["finalBboxRgbaPath"]) as saved:
            crop = saved.convert("RGBA")
        yy, xx = np.indices((crop.height, crop.width))
        gray = np.where((xx//8 + yy//8) % 2, 245, 185).astype(np.uint8)
        checker = Image.fromarray(np.repeat(gray[:, :, None], 3, axis=2)).convert("RGBA")
        view = Image.alpha_composite(checker, crop).convert("RGB")
        view.save(directory / (name + "-bbox-checker.png"))
        panels.append((view, name + " FINAL cropRGBA"))
    tile = Image.new("RGB", (1440, 540), "#202530")
    draw = ImageDraw.Draw(tile)
    draw.text((8, 4), title, fill="white")
    for index, (panel, label) in enumerate(panels):
        x, y = (index % 4)*360, 24+(index//4)*258
        draw.text((x+8, y), label, fill="white")
        scale = min(344/panel.width, 224/panel.height, 10)
        size = (max(1, round(panel.width*scale)), max(1, round(panel.height*scale)))
        display = panel.resize(size, Image.Resampling.NEAREST)
        tile.paste(display, (x+(360-size[0])//2, y+23+(224-size[1])//2))
    tile.save(directory / "comparison.png")
    return tile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--stage", choices=("smoke", "full"), required=True)
    args = parser.parse_args()
    run = args.run_dir.resolve()
    if run.parent != SAMPLES or not run.name.startswith("benchmark-sam2-"):
        raise ValueError("run-dir must be a new .data/ui-samples/benchmark-sam2-* directory")
    run.mkdir(exist_ok=False)
    start = time.perf_counter()
    before = protected_snapshot()
    write_json(run / "protected-before.json", before)
    report = {"stage": args.stage, "results": [], "images": [], "exceptions": [], "multimaskDiagnostics": [],
              "device": "cpu", "dtype": "float32", "threads": 4, "groundTruth": None,
              "measuredIou": None, "qualityPassRate": None, "multimaskOutput": False,
              "buildApplyPostprocessing": False, "maxHoleArea": 0, "maxSprinkleArea": 0,
              "baselines": "read-only existing HQ paired run; Mobile masks matched historical product run",
              "hqReportSha256": sha(HQ_REPORT), "sourceSha256": sha(SAMPLES / "source.json"),
              "pointsSha256": sha(POINTS), "scriptSha256": sha(Path(__file__)),
              "officialManifestSha256": sha(BASE / "official-manifest.json"),
              "timingScope": "offline subprocess; one model load and one embedding per image; not API latency"}
    try:
        import numpy as np
        from PIL import Image
        import torch
        torch.set_num_threads(4)
        sys.path.insert(0, str(BASE / "site"))
        sys.path.insert(0, str(BASE / "source"))
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        import sam2
        assert Path(sam2.__file__).resolve() == BASE / "source/sam2/__init__.py"
        report["sam2ImportedFrom"] = sam2.__file__
        report["packages"] = {p: importlib.metadata.version(p) for p in
                              ("torch", "torchvision", "numpy", "pillow", "hydra-core", "omegaconf", "iopath")}
        assert torch.__version__ == "2.8.0+cpu" and torch.version.cuda is None
        checkpoint = BASE / "sam2.1_hiera_small.pt"
        report["checkpointSha256"] = sha(checkpoint)
        assert report["checkpointSha256"] == "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38"
        load_start = time.perf_counter()
        model = build_sam2("configs/sam2.1/sam2.1_hiera_s.yaml", str(checkpoint),
                           device="cpu", mode="eval", apply_postprocessing=False)
        assert all(p.device.type == "cpu" and p.dtype == torch.float32 for p in model.parameters())
        predictor = SAM2ImagePredictor(model, mask_threshold=0.0, max_hole_area=0.0, max_sprinkle_area=0.0)
        report["modelLoadMs"] = (time.perf_counter()-load_start)*1000
        report["parameterCount"] = sum(p.numel() for p in model.parameters())
        print(json.dumps({"modelLoaded": True, "ms": report["modelLoadMs"], "parameters": report["parameterCount"]}), flush=True)
        manifest = json.loads((SAMPLES / "source.json").read_text(encoding="utf-8"))
        retry = json.loads(POINTS.read_text(encoding="utf-8"))
        old = json.loads(HQ_REPORT.read_text(encoding="utf-8"))
        baselines = {(r["id"], r["mode"]): r for r in old["results"]}
        with torch.inference_mode():
            for sample in manifest["samples"]:
                targets = [t for t in sample["targets"] if args.stage == "full" or sample["id"]+"/"+t["id"] in SMOKE]
                if not targets:
                    continue
                path = Path(sample["original_path"])
                assert sha(path) == sample["sha256"]
                with Image.open(path) as loaded:
                    source = loaded.convert("RGBA")
                original = np.asarray(source)
                encode_start = time.perf_counter()
                predictor.set_image(np.array(source.convert("RGB"), copy=True))
                encode_ms = (time.perf_counter()-encode_start)*1000
                report["images"].append({"id": sample["id"], "sha256": sha(path), "encodeMs": encode_ms})
                print(json.dumps({"encoded": sample["id"], "ms": encode_ms}), flush=True)
                tiles = []
                for target in targets:
                    key = sample["id"]+"/"+target["id"]
                    modes = [("bbox", [])]
                    if args.stage == "full" and key in retry:
                        modes.append(("points", retry[key]["points"]))
                    for mode, points in modes:
                        directory = run / sample["id"] / (target["id"]+"-"+mode)
                        directory.mkdir(parents=True)
                        box = target["bbox_xyxy"]
                        x0, y0, x1, y1 = box
                        assert all(type(v) is int for v in box) and 0 <= x0 < x1 <= source.width and 0 <= y0 < y1 <= source.height
                        request = {"imagePath": str(path), "bbox": box, "points": points}
                        assert request == baselines[(key, mode)]["request"]
                        write_json(directory / "request.json", request)
                        record = {"id": key, "mode": mode, "request": request}
                        predict_start = time.perf_counter()
                        masks, scores, _ = predictor.predict(
                            box=np.asarray(box, dtype=np.float32), multimask_output=False,
                            point_coords=np.asarray([[p["x"], p["y"]] for p in points], dtype=np.float32) if points else None,
                            point_labels=np.asarray([p["label"] for p in points], dtype=np.int32) if points else None)
                        predict_ms = (time.perf_counter()-predict_start)*1000
                        # Official predict() casts thresholded boolean masks back to float32 0/1.
                        assert np.all((masks == 0) | (masks == 1))
                        mask = masks[0].astype(np.bool_)
                        assert mask.dtype == np.bool_ and mask.shape == original.shape[:2]
                        rgba = np.array(original, copy=True)
                        rgba[~mask, 3] = 0
                        mask_path = directory / "sam2-mask.png"
                        rgba_path = directory / "sam2-rgba.png"
                        crop_path = directory / "sam2-bbox-rgba.png"
                        Image.fromarray(mask.astype(np.uint8)*255).save(mask_path)
                        Image.fromarray(rgba).save(rgba_path)
                        Image.fromarray(rgba).crop(box).save(crop_path)
                        saved = np.asarray(Image.open(rgba_path))
                        final = np.asarray(Image.open(crop_path))
                        assert np.array_equal(saved[:, :, :3], original[:, :, :3])
                        assert np.array_equal(saved[:, :, 3], np.where(mask, original[:, :, 3], 0))
                        assert np.array_equal(np.asarray(Image.open(mask_path)), mask.astype(np.uint8)*255)
                        assert np.array_equal(final, saved[y0:y1, x0:x1])
                        ys, xs = np.nonzero(mask)
                        inside = int(mask[y0:y1, x0:x1].sum())
                        result = {"score": float(scores[0]), "scoreIsMeasuredIou": False, "predictMs": predict_ms,
                                  "maskPath": str(mask_path), "rgbaPath": str(rgba_path), "finalBboxRgbaPath": str(crop_path),
                                  "maskSha256": sha(mask_path), "rgbaSha256": sha(rgba_path), "cropSha256": sha(crop_path),
                                  "maskPixels": int(mask.sum()), "insideBboxPixels": inside,
                                  "bboxCoverageDiagnosticOnly": inside/((x1-x0)*(y1-y0)),
                                  "outsideBboxPixelsDiagnosticOnly": int(mask.sum())-inside,
                                  "maskBounds": [int(xs.min()), int(ys.min()), int(xs.max())+1, int(ys.max())+1] if len(xs) else None,
                                  "checks": {"binaryMask": True, "sourceRgb": True, "sourceAlphaTimesMask": True, "exactBboxCrop": True}}
                        models = dict(baselines[(key, mode)]["models"])
                        for baseline in models.values():
                            assert sha(Path(baseline["maskPath"])) == baseline["maskSha256"]
                        models["sam2"] = result
                        record["models"] = models
                        tiles.append(comparison(source, box, points, models, directory, key+" / "+mode))
                        write_json(directory / "metadata.json", record)
                        report["results"].append(record)
                        write_json(run / "report.json", report)
                        print(json.dumps({"id": key, "mode": mode, "predictMs": predict_ms, "insidePixels": inside}), flush=True)
                        if args.stage == "full" and mode == "bbox" and key in retry:
                            candidate_dir = run / sample["id"] / (target["id"]+"-multimask-diagnostic")
                            candidate_dir.mkdir()
                            candidate_start = time.perf_counter()
                            candidates, candidate_scores, _ = predictor.predict(
                                box=np.asarray(box, dtype=np.float32), multimask_output=True)
                            candidate_ms = (time.perf_counter()-candidate_start)*1000
                            assert candidates.shape == (3, source.height, source.width)
                            assert np.all((candidates == 0) | (candidates == 1))
                            candidates = candidates.astype(np.bool_)
                            candidate_records = {}
                            for candidate_index, candidate in enumerate(candidates):
                                name = "candidate-"+str(candidate_index)
                                candidate_rgba = np.array(original, copy=True)
                                candidate_rgba[~candidate, 3] = 0
                                candidate_mask_path = candidate_dir / (name+"-mask.png")
                                candidate_rgba_path = candidate_dir / (name+"-rgba.png")
                                candidate_crop_path = candidate_dir / (name+"-bbox-rgba.png")
                                Image.fromarray(candidate.astype(np.uint8)*255).save(candidate_mask_path)
                                Image.fromarray(candidate_rgba).save(candidate_rgba_path)
                                Image.fromarray(candidate_rgba).crop(box).save(candidate_crop_path)
                                saved_candidate = np.asarray(Image.open(candidate_rgba_path))
                                assert np.array_equal(saved_candidate[:, :, :3], original[:, :, :3])
                                assert np.array_equal(saved_candidate[:, :, 3], np.where(candidate, original[:, :, 3], 0))
                                assert np.array_equal(np.asarray(Image.open(candidate_crop_path)), saved_candidate[y0:y1, x0:x1])
                                candidate_records[name] = {
                                    "index": candidate_index, "score": float(candidate_scores[candidate_index]),
                                    "scoreIsMeasuredIou": False, "maskPath": str(candidate_mask_path),
                                    "rgbaPath": str(candidate_rgba_path), "finalBboxRgbaPath": str(candidate_crop_path),
                                    "maskSha256": sha(candidate_mask_path), "rgbaSha256": sha(candidate_rgba_path),
                                    "cropSha256": sha(candidate_crop_path)}
                            diagnostic = {"id": key, "request": request, "multimaskOutput": True,
                                          "predictMs": candidate_ms, "candidates": candidate_records,
                                          "usedInSingleMaskBaseline": False}
                            write_json(candidate_dir / "metadata.json", diagnostic)
                            comparison(source, box, [], candidate_records, candidate_dir, key+" / MULTIMASK DIAGNOSTIC ONLY")
                            report["multimaskDiagnostics"].append(diagnostic)
                            print(json.dumps({"multimaskDiagnostic": key, "count": 3, "ms": candidate_ms}), flush=True)
                sheet = Image.new("RGB", (1440, 540*len(tiles)), "#202530")
                for index, tile in enumerate(tiles):
                    sheet.paste(tile, (0, 540*index))
                sheet.save(run / (sample["id"]+"-contact.png"))
        expected = 8 if args.stage == "smoke" else 22
        assert len(report["results"]) == expected
        report["successCount"] = expected
    except Exception as exc:
        report["exceptions"].append({"type": type(exc).__name__, "message": str(exc)})
        (run / "exception.txt").write_text(traceback.format_exc(), encoding="utf-8")
        traceback.print_exc()
    finally:
        after = protected_snapshot()
        write_json(run / "protected-after.json", after)
        report["protectedFilesUnchanged"] = before == after
        report["protectedFileCount"] = len(before)
        report["wallSecondsIncludingRenderingAndVerification"] = time.perf_counter()-start
        write_json(run / "report.json", report)
    print(json.dumps({"report": str(run / "report.json"), "success": report.get("successCount", 0),
                      "exceptions": report["exceptions"], "protectedUnchanged": report["protectedFilesUnchanged"]}), flush=True)
    return 0 if report.get("successCount") and report["protectedFilesUnchanged"] else 1


if __name__ == "__main__":
    sys.exit(main())
