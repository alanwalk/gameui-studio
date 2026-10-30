"""Paired offline MobileSAM / official Light HQ-SAM benchmark, without mask cleanup."""
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
ROOT = Path(__file__).resolve().parents[1]
HQ = ROOT / ".data/segmentation/hq"
SAMPLES = ROOT / ".data/ui-samples"
RETRY = SAMPLES / "benchmark-20261028-visual-retry-config01/points.json"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def protected_snapshot():
    paths = [ROOT / "scripts/segment.py", ROOT / "src/lib/segmentation.ts",
             ROOT / "docs/guide.md", SAMPLES / "source.json", RETRY]
    for folder in ("src", "server", "tests", ".venv-seg"):
        paths.extend(path for path in (ROOT / folder).rglob("*") if path.is_file())
    return {str(path.relative_to(ROOT)): sha(path) for path in sorted(set(paths))}


def preview_tile(source, box, points, results, directory, title):
    from PIL import Image, ImageDraw
    import numpy as np

    # Diagnostic crop includes all foreground; final assets always use the original bbox.
    bounds = [box] + [item["maskBounds"] for item in results.values()]
    crop = (max(0, min(b[0] for b in bounds)-12),
            max(0, min(b[1] for b in bounds)-12),
            min(source.width, max(b[2] for b in bounds)+12),
            min(source.height, max(b[3] for b in bounds)+12))
    original = source.convert("RGB")
    draw = ImageDraw.Draw(original)
    draw.rectangle(box, outline="#ffcf40", width=1)
    for point in points:
        x, y = point["x"], point["y"]
        color = "#00ff80" if point["label"] else "#ff3040"
        draw.ellipse((x-3, y-3, x+3, y+3), fill=color)
    panels = [(original.crop(crop), "source / prompt (union view)")]
    for name, result in results.items():
        mask = Image.open(result["maskPath"]).convert("L")
        tint = Image.new("RGBA", source.size, (0, 230, 100, 0))
        tint.putalpha(mask.point(lambda value: 95 if value else 0))
        overlay = Image.alpha_composite(source, tint).convert("RGB")
        overlay.crop(crop).save(directory / (name + "-overlay.png"))
        panels.append((overlay.crop(crop), name + " overlay / union"))
    panels.append((source.crop(box).convert("RGB"), "source / exact bbox"))
    for name, result in results.items():
        target = Image.open(result["finalBboxRgbaPath"]).convert("RGBA")
        yy, xx = np.indices((target.height, target.width))
        gray = np.where((xx//8 + yy//8) % 2, 245, 190).astype(np.uint8)
        checker = Image.fromarray(np.repeat(gray[:, :, None], 3, axis=2)).convert("RGBA")
        final_view = Image.alpha_composite(checker, target).convert("RGB")
        final_view.save(directory / (name + "-bbox-checker.png"))
        panels.append((final_view, name + " FINAL / exact bbox"))
    tile = Image.new("RGB", (1500, 550), "#202530")
    draw = ImageDraw.Draw(tile)
    draw.text((8, 4), title, fill="white")
    for index, (panel, label) in enumerate(panels):
        column, row = index % 3, index // 3
        x, y = column*500, 24+row*263
        draw.text((x+8, y), label, fill="white")
        scale = min(484/panel.width, 228/panel.height, 8)
        size = (max(1, round(panel.width*scale)), max(1, round(panel.height*scale)))
        display = panel.resize(size, Image.Resampling.NEAREST)
        tile.paste(display, (x+(500-size[0])//2, y+23+(228-size[1])//2))
    tile.save(directory / "comparison.png")
    return tile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    args = parser.parse_args()
    run_dir = args.run_dir.resolve()
    if run_dir.parent != SAMPLES or not run_dir.name.startswith("benchmark-hq-"):
        raise ValueError("run-dir must be a new .data/ui-samples/benchmark-hq-* directory")
    run_dir.mkdir(exist_ok=False)
    started = time.perf_counter()
    before = protected_snapshot()
    write_json(run_dir / "protected-before.json", before)
    report = {"groundTruth": None, "measuredIou": None, "device": "cpu", "threads": 4,
              "execution": "one process; each model loaded once; each full RGB encoded once per model per image; no mask cleanup",
              "hqTokenOnly": False, "multimaskOutput": False, "results": [], "images": [],
              "sourceSha256": sha(SAMPLES / "source.json"), "retrySha256": sha(RETRY),
              "scriptSha256": sha(Path(__file__)), "revisions": json.loads((HQ / "revisions.json").read_text()),
              "modelLoads": {}, "exceptions": []}
    try:
        import numpy as np
        from PIL import Image
        import torch
        torch.set_num_threads(4)
        import_started = time.perf_counter()
        from mobile_sam import SamPredictor as MobilePredictor, sam_model_registry as mobile_registry
        # Only this benchmark subprocess can resolve the downloaded official package.
        sys.path.insert(0, str(HQ / "source"))
        from segment_anything import SamPredictor as HqPredictor, sam_model_registry as hq_registry
        import segment_anything
        assert Path(segment_anything.__file__).resolve() == HQ / "source/segment_anything/__init__.py"
        report["modelImportsMs"] = (time.perf_counter()-import_started)*1000
        report["packages"] = {name: importlib.metadata.version(name)
                              for name in ("torch", "torchvision", "numpy", "pillow", "timm", "mobile-sam")}
        checkpoints = {"mobile": ROOT / ".data/segmentation/weights/mobile_sam.pt",
                       "hq": HQ / "sam_hq_vit_tiny.pth"}
        report["checkpointSha256"] = {name: sha(path) for name, path in checkpoints.items()}
        assert report["checkpointSha256"]["hq"] == "0f32c075ccdd870ae54db2f7630e7a0878ede5a2b06d05d6fe02c65a82fb7196"
        predictors = {}
        for name, registry, model_type, predictor_type in (
                ("mobile", mobile_registry, "vit_t", MobilePredictor),
                ("hq", hq_registry, "vit_tiny", HqPredictor)):
            load_started = time.perf_counter()
            model = registry[model_type](checkpoint=None)
            # Strict load additionally proves there are no silently missing HQ parameters.
            state = torch.load(checkpoints[name], map_location="cpu", weights_only=True)
            loaded = model.load_state_dict(state, strict=True)
            model.to(device="cpu").eval()
            predictors[name] = predictor_type(model)
            report["modelLoads"][name] = {"ms": (time.perf_counter()-load_started)*1000,
                                          "strict": True, "missingKeys": loaded.missing_keys,
                                          "unexpectedKeys": loaded.unexpected_keys}
            print(json.dumps({"modelLoaded": name, **report["modelLoads"][name]}), flush=True)
        manifest = json.loads((SAMPLES / "source.json").read_text(encoding="utf-8"))
        retry_specs = json.loads(RETRY.read_text(encoding="utf-8"))
        old_baseline = json.loads((SAMPLES / "benchmark-20261028-visual-baseline01/report.json").read_text(encoding="utf-8"))
        old_retry = json.loads((SAMPLES / "benchmark-20261028-visual-retry01/report.json").read_text(encoding="utf-8"))
        historical = {(item["id"], mode): item for mode, old in (("bbox", old_baseline), ("points", old_retry))
                      for item in old["results"]}
        with torch.inference_mode():
            for sample in manifest["samples"]:
                image_path = Path(sample["original_path"])
                assert sha(image_path) == sample["sha256"]
                with Image.open(image_path) as loaded:
                    source = loaded.convert("RGBA")
                source_rgba = np.asarray(source)
                rgb = np.asarray(source.convert("RGB"))
                image_record = {"id": sample["id"], "sha256": sha(image_path), "encodeMs": {}}
                for name, predictor in predictors.items():
                    encode_started = time.perf_counter()
                    predictor.set_image(rgb, image_format="RGB")
                    image_record["encodeMs"][name] = (time.perf_counter()-encode_started)*1000
                report["images"].append(image_record)
                tiles = []
                for target in sample["targets"]:
                    key = sample["id"] + "/" + target["id"]
                    modes = [("bbox", [])]
                    if key in retry_specs:
                        modes.append(("points", retry_specs[key]["points"]))
                    for mode, points in modes:
                        directory = run_dir / sample["id"] / (target["id"] + "-" + mode)
                        directory.mkdir(parents=True)
                        box = target["bbox_xyxy"]
                        request = {"imagePath": str(image_path), "bbox": box, "points": points}
                        write_json(directory / "request.json", request)
                        record = {"id": key, "mode": mode, "request": request, "models": {}}
                        try:
                            for name, predictor in predictors.items():
                                predict_args = {"box": np.asarray(box, dtype=np.float32), "multimask_output": False,
                                                "point_coords": None, "point_labels": None}
                                if points:
                                    predict_args["point_coords"] = np.asarray([[p["x"], p["y"]] for p in points], dtype=np.float32)
                                    predict_args["point_labels"] = np.asarray([p["label"] for p in points], dtype=np.int32)
                                if name == "hq":
                                    predict_args["hq_token_only"] = False
                                predict_started = time.perf_counter()
                                masks, scores, _ = predictor.predict(**predict_args)
                                predict_ms = (time.perf_counter()-predict_started)*1000
                                mask = masks[0]
                                assert mask.dtype == np.bool_ and mask.shape == source_rgba.shape[:2] and mask.any()
                                rgba = np.array(source_rgba, copy=True)
                                rgba[~mask, 3] = 0
                                mask_path = directory / (name + "-mask.png")
                                rgba_path = directory / (name + "-rgba.png")
                                final_path = directory / (name + "-bbox-rgba.png")
                                Image.fromarray(mask.astype(np.uint8)*255).save(mask_path)
                                Image.fromarray(rgba).save(rgba_path)
                                Image.fromarray(rgba).crop(box).save(final_path)
                                saved = np.asarray(Image.open(rgba_path))
                                saved_mask = np.asarray(Image.open(mask_path))
                                final = np.asarray(Image.open(final_path))
                                x0, y0, x1, y1 = box
                                assert np.array_equal(saved[:, :, :3], source_rgba[:, :, :3])
                                assert np.array_equal(saved[:, :, 3], np.where(mask, source_rgba[:, :, 3], 0))
                                assert np.array_equal(saved_mask, mask.astype(np.uint8)*255)
                                assert np.array_equal(final, saved[y0:y1, x0:x1])
                                ys, xs = np.nonzero(mask)
                                inside = int(mask[y0:y1, x0:x1].sum())
                                result = {"score": float(scores[0]), "predictMs": predict_ms,
                                          "maskPixels": int(mask.sum()), "insideBboxPixels": inside,
                                          "outsideBboxPixelsDiagnosticOnly": int(mask.sum())-inside,
                                          "maskBounds": [int(xs.min()), int(ys.min()), int(xs.max())+1, int(ys.max())+1],
                                          "maskPath": str(mask_path), "rgbaPath": str(rgba_path),
                                          "finalBboxRgbaPath": str(final_path), "maskSha256": sha(mask_path),
                                          "checks": {"binary": True, "sourceRgb": True, "sourceAlphaTimesMask": True, "exactBboxCrop": True}}
                                if name == "mobile":
                                    old_mask = np.asarray(Image.open(historical[(key, mode)]["result"]["maskPath"]))
                                    result["historicalChangedPixels"] = int(np.count_nonzero(old_mask != saved_mask))
                                record["models"][name] = result
                            tiles.append(preview_tile(source, box, points, record["models"], directory, key+" / "+mode))
                            print(json.dumps({"id": key, "mode": mode, "ok": True,
                                              "predictMs": {name: r["predictMs"] for name, r in record["models"].items()}}), flush=True)
                        except Exception as exc:
                            record["error"] = {"type": type(exc).__name__, "message": str(exc)}
                            (directory / "exception.txt").write_text(traceback.format_exc(), encoding="utf-8")
                            print(json.dumps({"id": key, "mode": mode, "error": record["error"]}), flush=True)
                        write_json(directory / "metadata.json", record)
                        report["results"].append(record)
                        write_json(run_dir / "report.json", report)
                sheet = Image.new("RGB", (1500, len(tiles)*550), "#202530")
                for index, tile in enumerate(tiles):
                    sheet.paste(tile, (0, index*550))
                sheet.save(run_dir / (sample["id"] + "-contact.png"))
        assert len(report["results"]) == 22
        report["successCount"] = sum("error" not in record for record in report["results"])
        report["errorCount"] = 22-report["successCount"]
    except Exception as exc:
        report["exceptions"].append({"type": type(exc).__name__, "message": str(exc)})
        (run_dir / "exception.txt").write_text(traceback.format_exc(), encoding="utf-8")
        traceback.print_exc()
    finally:
        after = protected_snapshot()
        write_json(run_dir / "protected-after.json", after)
        report["protectedFilesUnchanged"] = before == after
        report["protectedFileCount"] = len(before)
        report["wallSecondsIncludingVerificationAndRendering"] = time.perf_counter()-started
        write_json(run_dir / "report.json", report)
    print(json.dumps({"report": str(run_dir / "report.json"), "successCount": report.get("successCount", 0),
                      "errorCount": report.get("errorCount"), "exceptions": report["exceptions"],
                      "protectedFilesUnchanged": report["protectedFilesUnchanged"]}), flush=True)
    return 0 if report.get("successCount") == 22 and report["protectedFilesUnchanged"] else 1


if __name__ == "__main__":
    sys.exit(main())
