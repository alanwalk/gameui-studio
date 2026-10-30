"""Offline visual benchmark; calls the product segment() without altering its algorithm."""
import argparse
import contextlib
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
import traceback

from PIL import Image, ImageDraw
import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def comparison(source, request, result, directory, label):
    box = request["bbox"]
    bounds = result["maskBounds"]
    # Include all returned pixels so an overflowing mask cannot be hidden by the prompt crop.
    left = max(0, min(box[0], bounds[0]) - 12)
    top = max(0, min(box[1], bounds[1]) - 12)
    right = min(source.width, max(box[2], bounds[2]) + 12)
    bottom = min(source.height, max(box[3], bounds[3]) + 12)
    crop = (left, top, right, bottom)
    original = source.convert("RGB")
    draw = ImageDraw.Draw(original)
    draw.rectangle(box, outline="#ffcf40", width=2)
    for point in request["points"]:
        x, y = point["x"], point["y"]
        color = "#00ff80" if point["label"] else "#ff3040"
        draw.ellipse((x-3, y-3, x+3, y+3), fill=color)
    mask = Image.open(result["maskPath"]).convert("L")
    target = Image.open(result["rgbaPath"]).convert("RGBA")
    source_pixels = np.asarray(source)
    target_pixels = np.asarray(target)
    mask_pixels = np.asarray(mask)
    assert mask.size == source.size and target.size == source.size
    assert set(np.unique(mask_pixels)).issubset({0, 255})
    assert np.array_equal(source_pixels[:, :, :3], target_pixels[:, :, :3])
    expected_alpha = np.where(mask_pixels != 0, source_pixels[:, :, 3], 0)
    assert np.array_equal(expected_alpha, target_pixels[:, :, 3])
    outside = mask_pixels != 0
    outside[int(box[1]):int(box[3]), int(box[0]):int(box[2])] = False
    result["checks"] = {"binaryMask": True, "sourceRgbPreserved": True,
                        "alphaMatchesMask": True, "outsidePromptPixels": int(outside.sum())}
    overlay = source.copy()
    tint = Image.new("RGBA", source.size, (0, 230, 100, 0))
    tint.putalpha(mask.point(lambda value: 95 if value else 0))
    overlay = Image.alpha_composite(overlay, tint).convert("RGB")
    ImageDraw.Draw(overlay).rectangle(box, outline="#ffcf40", width=2)
    y, x = np.indices((source.height, source.width))
    checker_values = np.where((x // 8 + y // 8) % 2 == 0, 205, 245).astype(np.uint8)
    checker = Image.fromarray(np.repeat(checker_values[:, :, None], 3, axis=2)).convert("RGBA")
    checker = Image.alpha_composite(checker, target).convert("RGB")
    original.crop(crop).save(directory / "original-box.png")
    overlay.crop(crop).save(directory / "mask-overlay.png")
    checker.crop(crop).save(directory / "rgba-checker.png")
    result["visualCropXYXY"] = list(crop)
    panels = [(original, "source / prompt"), (overlay, "mask overlay"),
              (checker, "RGBA / checker"), (mask.convert("RGB"), "binary mask")]
    tile = Image.new("RGB", (1200, 256), "#202530")
    draw = ImageDraw.Draw(tile)
    draw.text((8, 5), label, fill="white")
    for index, (panel, title) in enumerate(panels):
        draw.text((index * 300 + 8, 27), title, fill="white")
        preview = panel.crop(crop)
        scale = min(288 / preview.width, 202 / preview.height, 6)
        preview = preview.resize((max(1, round(preview.width * scale)),
                                  max(1, round(preview.height * scale))), Image.Resampling.NEAREST)
        tile.paste(preview, (index * 300 + (300-preview.width)//2, 50+(202-preview.height)//2))
    tile.save(directory / "comparison.png")
    return tile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--retry-spec", type=Path)
    parser.add_argument("--render-existing", action="store_true")
    args = parser.parse_args()
    run_dir = args.run_dir.resolve()
    sample_root = (ROOT / ".data/ui-samples").resolve()
    if run_dir.parent != sample_root or not run_dir.name.startswith("benchmark-"):
        raise ValueError("run-dir must be a fresh .data/ui-samples/benchmark-* directory")
    if args.render_existing:
        report = json.loads((run_dir / "report.json").read_text(encoding="utf-8"))
        sheets = {}
        for record in report["results"]:
            if "error" in record:
                continue
            with Image.open(record["request"]["imagePath"]) as loaded:
                source = loaded.convert("RGBA")
            tile = comparison(source, record["request"], record["result"],
                              Path(record["directory"]), record["id"])
            sample_id = record["id"].split("/")[0]
            sheets.setdefault(sample_id, []).append(tile)
        for sample_id, tiles in sheets.items():
            sheet = Image.new("RGB", (1200, len(tiles)*256), "#202530")
            for index, tile in enumerate(tiles):
                sheet.paste(tile, (0, index*256))
            sheet.save(run_dir / (sample_id + "-contact.png"))
        print(json.dumps({"renderedSheets": len(sheets), "runDir": str(run_dir)}))
        return 0
    run_dir.mkdir(exist_ok=False)
    source_path = sample_root / "source.json"
    source_bytes = source_path.read_bytes()
    manifest = json.loads(source_bytes)
    spec = importlib.util.spec_from_file_location("benchmark_product_segment", ROOT / "scripts/segment.py")
    product = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(product)
    checkpoint = product.DEFAULT_CHECKPOINT
    # The only runtime override isolates files in this benchmark's owned directory.
    product.DATA = run_dir / "product-output"
    retry_specs = {}
    if args.retry_spec:
        retry_specs = json.loads(args.retry_spec.read_text(encoding="utf-8"))
        if len(retry_specs) > 2:
            raise ValueError("at most two target retries are allowed")
    report = {"sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
              "implementationSha256": hashlib.sha256((ROOT / "scripts/segment.py").read_bytes()).hexdigest(),
              "mode": "point-retry" if args.retry_spec else "baseline",
              "execution": "one Python process; real segment() per target; no model/embedding cache",
              "groundTruth": None, "measuredIou": None, "qualityThreshold": "NOT_ESTABLISHED",
              "threads": 4, "results": []}
    started = time.perf_counter()
    for sample in manifest["samples"]:
        image_path = Path(sample["original_path"])
        image_hash = hashlib.sha256(image_path.read_bytes()).hexdigest()
        assert image_hash == sample["sha256"], f"source changed: {sample['id']}"
        with Image.open(image_path) as loaded:
            source = loaded.convert("RGBA")
        assert source.size == (sample["width"], sample["height"])
        tiles = []
        for target in sample["targets"]:
            key = sample["id"] + "/" + target["id"]
            if args.retry_spec and key not in retry_specs:
                continue
            directory = run_dir / sample["id"] / target["id"]
            directory.mkdir(parents=True)
            points = retry_specs[key]["points"] if args.retry_spec else []
            request = {"imagePath": str(image_path), "bbox": target["bbox_xyxy"],
                       "points": points, "output": "files"}
            write_json(directory / "request.json", request)
            record = {"id": key, "kind": target["kind"], "description": target["description"],
                      "sourceSha256": image_hash, "request": request, "directory": str(directory)}
            if args.retry_spec:
                record["retryRationale"] = retry_specs[key].get("rationale")
            call_started = time.perf_counter()
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    result = product.segment(request, checkpoint, 4)
                record["callWallMs"] = round((time.perf_counter()-call_started)*1000, 3)
                record["result"] = result
                tile = comparison(source, request, result, directory, key)
                tiles.append(tile)
                print(json.dumps({"id": key, "ok": True, "score": result["score"],
                                  "elapsedMs": result["elapsedMs"], "directory": str(directory)}), flush=True)
            except Exception as exc:
                record["callWallMs"] = round((time.perf_counter()-call_started)*1000, 3)
                record["error"] = {"type": type(exc).__name__, "message": str(exc)}
                (directory / "exception.txt").write_text(traceback.format_exc(), encoding="utf-8")
                print(json.dumps({"id": key, "error": record["error"]}), flush=True)
            write_json(directory / "metadata.json", record)
            report["results"].append(record)
            write_json(run_dir / "report.json", report)
        if tiles:
            sheet = Image.new("RGB", (1200, len(tiles)*256), "#202530")
            for index, tile in enumerate(tiles):
                sheet.paste(tile, (0, index*256))
            sheet.save(run_dir / (sample["id"] + "-contact.png"))
    report["wallSeconds"] = round(time.perf_counter()-started, 3)
    report["successCount"] = sum("error" not in item for item in report["results"])
    report["errorCount"] = len(report["results"]) - report["successCount"]
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == report["sourceSha256"]
    if not args.retry_spec:
        assert len(report["results"]) == 20
    else:
        assert len(report["results"]) == len(retry_specs)
    write_json(run_dir / "report.json", report)
    print(json.dumps({"report": str(run_dir / "report.json"), "successCount": report["successCount"],
                      "errorCount": report["errorCount"], "wallSeconds": report["wallSeconds"]}), flush=True)
    return 1 if report["errorCount"] else 0


if __name__ == "__main__":
    sys.exit(main())
