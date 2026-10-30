"""Offline CPU matting experiment. Existing screenshots and SAM2 outputs are read-only."""
import argparse
import hashlib
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import shutil
import sys
import time
import traceback
import warnings

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / ".data/matting"
SAMPLES = ROOT / ".data/ui-samples"
SAM = SAMPLES / "benchmark-sam2-20261028-full01"
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.environ["NUMBA_CACHE_DIR"] = str(BASE / "numba-cache")
os.environ["NUMBA_NUM_THREADS"] = "4"
sys.path.insert(0, str(BASE / "site"))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def save_rgb(path, pixels):
    Image.fromarray(np.rint(np.clip(pixels, 0, 1) * 255).astype(np.uint8)).save(path)


def composite(rgb, alpha, background):
    return rgb * alpha[:, :, None] + background * (1 - alpha[:, :, None])


def board(path, panels, title):
    width, height = 350, 300
    result = Image.new("RGB", (width * 4, height * ((len(panels) + 3) // 4) + 30), "#202530")
    draw = ImageDraw.Draw(result)
    draw.text((8, 7), title, fill="white")
    for index, (panel, label) in enumerate(panels):
        x, y = index % 4 * width, index // 4 * height + 30
        draw.text((x + 8, y + 4), label, fill="white")
        scale = min((width - 16) / panel.width, (height - 35) / panel.height)
        size = (max(1, round(panel.width * scale)), max(1, round(panel.height * scale)))
        display = panel.convert("RGB").resize(size, Image.Resampling.NEAREST)
        result.paste(display, (x + (width - size[0]) // 2, y + 28))
    result.save(path)


def automatic_trimap(mask):
    # Three-pixel Chebyshev band; no color heuristics or manual target knowledge.
    foreground = ndi.binary_erosion(mask, structure=np.ones((7, 7), dtype=bool), border_value=0)
    support = ndi.binary_dilation(mask, structure=np.ones((7, 7), dtype=bool), border_value=0)
    trimap = np.full(mask.shape, 0.5, dtype=np.float64)
    trimap[~support] = 0
    trimap[foreground] = 1
    return trimap


def manual_trimap(shape, annotation):
    canvas = Image.new("L", (shape[1], shape[0]), 128)
    draw = ImageDraw.Draw(canvas)
    for stroke in annotation["strokes"]:
        value = 255 if stroke["label"] == "foreground" else 0
        points = [tuple(p) for p in stroke["points_roi_xy"]]
        draw.line(points, fill=value, width=stroke["width"])
    values = np.asarray(canvas)
    result = np.full(shape, 0.5, dtype=np.float64)
    result[values == 0] = 0
    result[values == 255] = 1
    return result


def export_result(directory, image, mask, trimap, alpha, foreground, background, record):
    directory.mkdir(exist_ok=False)
    save_rgb(directory / "alpha.png", alpha)
    Image.fromarray(np.rint(alpha * 65535).astype(np.uint16)).save(directory / "alpha16.png")
    np.savez_compressed(directory / "estimates.npz", alpha=alpha, foreground=foreground, background=background)
    alpha_bytes = np.rint(alpha * 255).astype(np.uint8)
    original_bytes = np.rint(image * 255).astype(np.uint8)
    estimated_bytes = np.rint(np.clip(foreground, 0, 1) * 255).astype(np.uint8)
    Image.fromarray(np.dstack((original_bytes, alpha_bytes))).save(directory / "alpha-only-RGBA.png")
    Image.fromarray(np.dstack((estimated_bytes, alpha_bytes))).save(directory / "foregroundRGBA.png")
    assert np.array_equal(np.asarray(Image.open(directory / "alpha-only-RGBA.png"))[:, :, :3], original_bytes)
    assert np.array_equal(np.asarray(Image.open(directory / "foregroundRGBA.png"))[:, :, 3], alpha_bytes)
    y, x = np.indices(alpha.shape)
    checker = np.repeat(np.where((x // 8 + y // 8) % 2, .85, .45)[:, :, None], 3, axis=2)
    panels = [(Image.fromarray(original_bytes), "SOURCE context crop"),
              (Image.fromarray(mask.astype(np.uint8) * 255), "SAM2 mask (unchanged)"),
              (Image.fromarray(np.rint(trimap * 255).astype(np.uint8)), "TRIMAP 0/BG .5/? 1/FG"),
              (Image.open(directory / "alpha.png"), "Estimated ALPHA")]
    save_rgb(directory / "sam2-checker.png", composite(image, mask, checker))
    panels.append((Image.open(directory / "sam2-checker.png"), "SAM2 + original RGB / checker"))
    for label, rgb in (("alpha-only", image), ("foreground", foreground)):
        for bg_name, bg in (("checker", checker), ("white", np.ones_like(image)),
                            ("black", np.zeros_like(image)), ("source", image)):
            save_rgb(directory / f"{label}-over-{bg_name}.png", composite(rgb, alpha, bg))
        panels.append((Image.open(directory / f"{label}-over-checker.png"), label + " / checker"))
    save_rgb(directory / "rgb-change-x4.png", np.abs(foreground - image) * 4)
    panels.append((Image.open(directory / "rgb-change-x4.png"), "abs(F - original RGB) x4"))
    save_rgb(directory / "estimated-background.png", background)
    reconstruction = composite(foreground, alpha, background)
    save_rgb(directory / "reconstruction-estimated-background.png", reconstruction)
    panels.extend([(Image.open(directory / "alpha-only-over-source.png"), "alpha-only OVER SOURCE*"),
                   (Image.open(directory / "foreground-over-source.png"), "foreground OVER SOURCE*"),
                   (Image.open(directory / "estimated-background.png"), "Estimated B (NOT clean truth)"),
                   (Image.open(directory / "reconstruction-estimated-background.png"), "F*a + estimated B*(1-a)")])
    board(directory / "comparison.png", panels, record["id"] + " / " + record["trimapMode"] + " / " + record["algorithm"])
    record["originalCompositeCaveat"] = "SOURCE is the already composited screenshot, not the unavailable clean scene. Re-overlay is not recovery validation."
    record["statistics"] = {
        "pixels": int(alpha.size), "foregroundSeeds": int((trimap == 1).sum()),
        "backgroundSeeds": int((trimap == 0).sum()), "unknown": int((trimap == .5).sum()),
        "softAlphaPixels_001_099": int(((alpha > .01) & (alpha < .99)).sum()),
        "meanAlphaAtForegroundSeeds": float(alpha[trimap == 1].mean()),
        "maxForegroundSeedAlphaDeviation": float(np.abs(alpha[trimap == 1] - 1).max()),
        "meanAbsForegroundRgbChange_0_255": float(np.abs(foreground - image)[alpha > .01].mean() * 255),
        "estimatedBackgroundReconstructionMAE_0_255": float(np.abs(reconstruction - image).mean() * 255)}
    record["outputs"] = {p.name: {"path": str(p), "sha256": sha(p)} for p in directory.iterdir() if p.is_file()}
    write_json(directory / "result.json", record)


def self_check():
    # Known synthetic layers check wiring, not screenshot extraction quality.
    y, x = np.indices((40, 48))
    alpha = np.clip((x - 8) / 30, 0, 1)
    foreground = np.zeros((40, 48, 3)) + [.85, .1, .2]
    background = np.zeros_like(foreground) + [.1, .7, .8]
    observed = composite(foreground, alpha, background)
    estimate_f, estimate_b = estimate_foreground_ml(observed, alpha, return_background=True)
    alpha_only_error = float(np.abs(observed - foreground)[alpha > .1].mean())
    estimated_error = float(np.abs(estimate_f - foreground)[alpha > .1].mean())
    assert estimated_error < alpha_only_error
    mask = (x > 10) & (x < 38) & (y > 5) & (y < 35)
    trimap = automatic_trimap(mask)
    assert set(np.unique(trimap)) == {0, .5, 1}
    assert np.all(mask[trimap == 1]) and np.all(~mask[trimap == 0])
    return {"knownLayers": True, "alphaOnlyRgbMAE": alpha_only_error,
            "estimatedForegroundRgbMAE": estimated_error, "isUiAcceptance": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--manual", type=Path, help="One explicit human/agent scribble diagnostic, separate from all automatic cases")
    args = parser.parse_args()
    run = args.run_dir.resolve()
    if run.parent != SAMPLES or not run.name.startswith("benchmark-matting-"):
        raise ValueError("run-dir must be a new .data/ui-samples/benchmark-matting-* directory")
    run.mkdir(exist_ok=False)
    started = time.perf_counter()
    report = {"results": [], "exceptions": [], "device": "CPU", "threads": 4,
              "groundTruth": None, "qualityAccepted": None, "reviewStatus": "AWAITING_MAIN_THREAD_VISUAL_REVIEW",
              "scriptSha256": sha(__file__), "sourceManifestSha256": sha(SAMPLES / "source.json"),
              "algorithms": {"cf": {"laplacian_kwargs": {"epsilon": 1e-7}, "cg_kwargs": {"maxiter": 2000}},
                             "knn": {"cg_kwargs": {"maxiter": 2000}}},
              "trimapRule": "SAM2 mask erosion/dilation radius=3 pixels (7x7 square), original resolution; context padding=12; no color heuristics",
              "versions": {}, "signatures": {}, "inputFiles": {}}
    try:
        global np, ndi, Image, ImageDraw, estimate_foreground_ml
        import numpy as np
        import scipy.ndimage as ndi
        from PIL import Image, ImageDraw
        import_start = time.perf_counter()
        from pymatting import estimate_alpha_cf, estimate_alpha_knn, estimate_foreground_ml
        report["pymattingImportMs_includingJit"] = (time.perf_counter() - import_start) * 1000
        for package in ("pymatting", "numpy", "pillow", "scipy", "numba", "llvmlite"):
            report["versions"][package] = importlib.metadata.version(package)
        for function in (estimate_alpha_cf, estimate_alpha_knn, estimate_foreground_ml):
            location = Path(inspect.getfile(function)).resolve()
            assert location.is_relative_to(BASE / "site")
            report["signatures"][function.__name__] = {"signature": str(inspect.signature(function)),
                                                      "path": str(location), "sha256": sha(location)}
        warm_start = time.perf_counter()
        report["selfCheck"] = self_check()
        report["selfCheckAndForegroundWarmupMs"] = (time.perf_counter() - warm_start) * 1000
        print(json.dumps({"importMs": report["pymattingImportMs_includingJit"], "versions": report["versions"],
                          "selfCheck": report["selfCheck"]}), flush=True)
        manifest = json.loads((SAMPLES / "source.json").read_text(encoding="utf-8"))
        selected = [("supertuxkart", "minimap"), ("supertuxkart", "speedometer"),
                    ("supertuxkart", "rank"), ("wesnoth", "magnifier")]
        annotation = None
        if args.manual:
            annotation = json.loads(args.manual.read_text(encoding="utf-8"))
            assert annotation["id"] in [s + "/" + t for s, t in selected]
            shutil.copyfile(args.manual, run / "manual-scribbles.json")
            report["manualInput"] = {"path": str(args.manual.resolve()), "sha256": sha(args.manual),
                                     "provenance": annotation["provenance"]}
        for sample_id, target_id in selected:
            key = sample_id + "/" + target_id
            if annotation and annotation["id"] != key:
                continue
            sample = next(s for s in manifest["samples"] if s["id"] == sample_id)
            target = next(t for t in sample["targets"] if t["id"] == target_id)
            source_path = ROOT / sample["relative_path"]
            assert sha(source_path) == sample["sha256"]
            mask_path = SAM / sample_id / (target_id + "-bbox") / "sam2-mask.png"
            metadata_path = mask_path.with_name("metadata.json")
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            assert metadata["request"]["bbox"] == target["bbox_xyxy"]
            assert sha(mask_path) == metadata["models"]["sam2"]["maskSha256"]
            for path in (source_path, mask_path, metadata_path):
                report["inputFiles"][str(path)] = sha(path)
            original = Image.open(source_path).convert("RGB")
            full_mask = Image.open(mask_path).convert("L")
            assert full_mask.size == original.size
            x0, y0, x1, y1 = target["bbox_xyxy"]
            roi = [max(0, x0 - 12), max(0, y0 - 12), min(original.width, x1 + 12), min(original.height, y1 + 12)]
            crop = original.crop(roi)
            mask_bytes = np.asarray(full_mask.crop(roi))
            assert np.all((mask_bytes == 0) | (mask_bytes == 255))
            mask = mask_bytes == 255
            image = np.asarray(crop).astype(np.float64) / 255
            if annotation:
                assert annotation["roi_xyxy"] == roi
                trimap = manual_trimap(mask.shape, annotation)
                trimap_mode = "manual-diagnostic-NOT-AUTOMATIC"
            else:
                trimap = automatic_trimap(mask)
                trimap_mode = "automatic-sam2"
            directory = run / sample_id / target_id
            directory.mkdir(parents=True)
            shutil.copyfile(source_path, directory / ("source" + source_path.suffix))
            annotated_source = original.copy()
            ImageDraw.Draw(annotated_source).rectangle(target["bbox_xyxy"], outline="red", width=2)
            annotated_source.save(directory / "source-box.png")
            original.crop(target["bbox_xyxy"]).save(directory / "crop-exact-bbox.png")
            crop.save(directory / "crop-context.png")
            full_mask.crop(roi).save(directory / "mask.png")
            save_rgb(directory / "trimap.png", trimap)
            request = {"id": key, "source": sample, "target": target, "roi_xyxy": roi,
                       "maskPath": str(mask_path), "maskSha256": sha(mask_path), "trimapMode": trimap_mode}
            write_json(directory / "input.json", request)
            for algorithm, estimate in (("cf", estimate_alpha_cf), ("knn", estimate_alpha_knn)):
                record = {"id": key, "algorithm": algorithm, "trimapMode": trimap_mode,
                          "roi_xyxy": roi, "timingScope": "original-resolution ROI, alpha and foreground separately; I/O excluded; first alpha invocation may compile"}
                try:
                    assert (trimap == 0).any() and (trimap == 1).any() and (trimap == .5).any()
                    with warnings.catch_warnings(record=True) as caught:
                        warnings.simplefilter("always")
                        alpha_start = time.perf_counter()
                        alpha = estimate(image, trimap, **report["algorithms"][algorithm])
                        record["alphaMs"] = (time.perf_counter() - alpha_start) * 1000
                        assert alpha.shape == mask.shape and np.isfinite(alpha).all()
                        assert alpha.min() >= 0 and alpha.max() <= 1
                        foreground_start = time.perf_counter()
                        foreground, background = estimate_foreground_ml(image, alpha, return_background=True)
                        record["foregroundMs"] = (time.perf_counter() - foreground_start) * 1000
                        assert np.isfinite(foreground).all() and np.isfinite(background).all()
                        record["warnings"] = [str(w.message) for w in caught]
                    export_result(directory / algorithm, image, mask, trimap, alpha, foreground, background, record)
                    record["status"] = "EXECUTED_NOT_QUALITY_ACCEPTED"
                    print(json.dumps({k: record[k] for k in ("id", "algorithm", "trimapMode", "alphaMs", "foregroundMs", "statistics", "warnings")}), flush=True)
                except Exception:
                    record["status"] = "ERROR"
                    record["error"] = traceback.format_exc()
                    report["exceptions"].append(record)
                    traceback.print_exc()
                report["results"].append(record)
                write_json(run / "report.json", report)
        assert all(sha(path) == digest for path, digest in report["inputFiles"].items())
        report["inputFilesUnchanged"] = True
        report["torchImported"] = "torch" in sys.modules
        assert not report["torchImported"]
    except Exception:
        report["exceptions"].append({"error": traceback.format_exc()})
        traceback.print_exc()
    finally:
        report["wallMs"] = (time.perf_counter() - started) * 1000
        write_json(run / "report.json", report)
    if report["exceptions"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
