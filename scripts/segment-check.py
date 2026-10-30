"""Exercise the real CLI, preserve command/stdout/stderr evidence, and render comparisons."""
import base64
import io
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / ".data/segmentation"
SOURCE = ROOT / ".data/images/screen-1793144933666-c4z2yw.png"
CLI = ROOT / "scripts/segment.py"


def invoke(evidence, name, request, extra_args=(), expected_ok=True):
    command = [sys.executable, str(CLI), *extra_args]
    stdin = json.dumps(request)
    (evidence / f"{name}.request.json").write_text(stdin, encoding="utf-8")
    started = time.perf_counter()
    process = subprocess.run(command, input=stdin, text=True, encoding="utf-8",
                             capture_output=True, cwd=ROOT, timeout=180)
    wall_ms = round((time.perf_counter() - started) * 1000, 3)
    (evidence / f"{name}.stdout.log").write_text(process.stdout, encoding="utf-8")
    (evidence / f"{name}.stderr.log").write_text(process.stderr, encoding="utf-8")
    execution = {"command": command, "cwd": str(ROOT), "stdinFile": f"{name}.request.json",
                 "exitCode": process.returncode, "wallMs": wall_ms}
    (evidence / f"{name}.command.json").write_text(json.dumps(execution, indent=2), encoding="utf-8")
    assert len(process.stdout.splitlines()) == 1, f"{name}: stdout must be one JSON line"
    response = json.loads(process.stdout)
    assert response["ok"] is expected_ok, response
    assert process.returncode == (0 if expected_ok else 1), execution
    return response, execution


def verify_pixels(source, mask_image, target_image, response):
    assert source.size == mask_image.size == target_image.size
    assert mask_image.mode == "L" and target_image.mode == "RGBA"
    original = np.asarray(source.convert("RGBA"))
    mask = np.asarray(mask_image)
    target = np.asarray(target_image)
    assert set(np.unique(mask)).issubset({0, 255})
    assert (mask > 0).any()
    assert response["protocolVersion"] == 2
    assert response["quality"]["status"] in ("review", "failed")
    visible = target[:, :, 3] > 0
    assert visible.any()
    for key in ("promptBounds", "inferenceBounds", "maskBounds", "outputBounds"):
        left, top, right, bottom = response[key]
        assert all(type(value) is int for value in response[key])
        assert 0 <= left < right <= source.width and 0 <= top < bottom <= source.height
    left, top, right, bottom = response["outputBounds"]
    outside = visible.copy()
    outside[top:bottom, left:right] = False
    assert not outside.any(), "visible alpha was clipped by the declared output bounds"
    rows, columns = np.nonzero(mask)
    assert response["maskBounds"] == [int(columns.min()), int(rows.min()), int(columns.max()) + 1, int(rows.max()) + 1]
    refinement = response["refinement"]
    if refinement["status"] in ("preserved", "degraded"):
        assert np.array_equal(target[:, :, :3][visible], original[:, :, :3][visible]), "native foreground RGB changed"
        assert np.array_equal(target[:, :, 3], np.where(mask > 0, original[:, :, 3], 0))
    else:
        assert refinement["method"] == "pymatting-cf"
        assert refinement["softAlphaPixels"] == int(((target[:, :, 3] > 0) & (target[:, :, 3] < 255)).sum())
    if refinement["status"] == "degraded":
        assert refinement["reason"], "an unrefined result must disclose its cause"


def comparison(source, mask_image, target, box, destination):
    margin = 24
    crop = (max(0, box[0] - margin), max(0, box[1] - margin),
            min(source.width, box[2] + margin), min(source.height, box[3] + margin))
    original = source.convert("RGB").crop(crop)
    mask_crop = mask_image.crop(crop)
    overlay = original.copy()
    green = Image.new("RGB", original.size, (0, 240, 100))
    tinted = Image.blend(original, green, 0.45)
    overlay.paste(tinted, mask=mask_crop)
    draw = ImageDraw.Draw(overlay)
    draw.rectangle((box[0] - crop[0], box[1] - crop[1], box[2] - crop[0], box[3] - crop[1]), outline="red")
    checker = Image.new("RGBA", original.size, (220, 220, 220, 255))
    checker_draw = ImageDraw.Draw(checker)
    for y in range(0, checker.height, 8):
        for x in range(0, checker.width, 8):
            if (x // 8 + y // 8) % 2:
                checker_draw.rectangle((x, y, x + 7, y + 7), fill=(150, 150, 150, 255))
    checker = Image.alpha_composite(checker, target.crop(crop)).convert("RGB")
    panels = [original, overlay, mask_crop.convert("RGB"), checker]
    labels = ["SOURCE", "MASK + BBOX", "BINARY MASK", "RGBA ON CHECKER"]
    scale = 3
    panel_width, panel_height = original.width * scale, original.height * scale
    canvas = Image.new("RGB", (panel_width * 4, panel_height + 28), "white")
    draw = ImageDraw.Draw(canvas)
    for index, panel in enumerate(panels):
        canvas.paste(panel.resize((panel_width, panel_height), Image.Resampling.NEAREST), (index * panel_width, 28))
        draw.text((index * panel_width + 4, 8), labels[index], fill="black")
    canvas.save(destination)


def main():
    evidence = DATA / ("check-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    evidence.mkdir(parents=True, exist_ok=False)
    print(f"Evidence: {evidence}", file=sys.stderr, flush=True)
    report = {"evidence": str(evidence), "samples": [], "checks": [],
              "qualityScope": "Two smoke samples, no ground truth; not a 90% quality acceptance."}
    report["python"] = sys.version
    report["packages"] = {name: importlib.metadata.version(name) for name in
                          ("torch", "torchvision", "numpy", "pillow", "timm", "mobile_sam")}
    manifest = json.loads((DATA / "official-manifest.json").read_text(encoding="utf-8"))
    report["sourceCommit"] = manifest["commit"]
    report["sourceImageSha256"] = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    with Image.open(SOURCE) as image:
        source = image.convert("RGBA")
    for name, box in [("coin", [357, 56, 420, 127]), ("gem", [630, 52, 681, 128])]:
        request = {"imagePath": str(SOURCE), "bbox": box, "output": "files"}
        response, execution = invoke(evidence, name, request)
        assert response["checkpointSha256"] == manifest["weightsSha256"]
        with Image.open(response["maskPath"]) as mask, Image.open(response["rgbaPath"]) as target:
            verify_pixels(source, mask, target, response)
            mask_array = np.asarray(mask) > 0
            x0, y0, x1, y1 = box
            inside_ratio = float(mask_array[y0:y1, x0:x1].sum() / mask_array.sum())
            assert inside_ratio > 0.8, f"{name}: mask is not localized near its prompt"
            comparison(source, mask, target, box, evidence / f"{name}-comparison.png")
        report["samples"].append({"name": name, "response": response, "execution": execution,
                                  "maskInsideBoxRatio": inside_ratio,
                                  "comparison": str(evidence / f"{name}-comparison.png")})
        print(json.dumps({"sample": name, "wallMs": execution["wallMs"],
                          "maskPixels": response["maskPixels"], "timings": response["timings"]}), flush=True)
    # Use both prompt labels and the independent input/output transport in a real inference.
    request = {"imageBase64": base64.b64encode(SOURCE.read_bytes()).decode("ascii"),
               "bbox": [357, 56, 420, 127],
               "points": [{"x": 388, "y": 90, "label": 1}, {"x": 350, "y": 50, "label": 0}]}
    response, execution = invoke(evidence, "base64-points", request)
    for field in ("width", "height", "maskBase64", "rgbaBase64", "score", "elapsedMs", "model"):
        assert field in response, f"missing API response field: {field}"
    assert response["score"] == response["predictedIou"]
    assert response["elapsedMs"] == response["timings"]["totalMs"]
    with Image.open(io.BytesIO(base64.b64decode(response["maskBase64"]))) as mask, \
         Image.open(io.BytesIO(base64.b64decode(response["rgbaBase64"]))) as target:
        verify_pixels(source, mask, target, response)
    report["checks"].append({"name": "base64-and-positive-negative-points", "passed": True,
                              "execution": execution, "timings": response["timings"]})
    invalid_cases = [
        ("out-of-bounds", {"bbox": [-1, 56, 420, 127]}, ()),
        ("reversed-box", {"bbox": [420, 56, 357, 127]}, ()),
        ("nonfinite-box", {"bbox": [357, 56, float("nan"), 127]}, ()),
        ("invalid-point-label", {"points": [{"x": 388, "y": 90, "label": 2}]}, ()),
        ("dual-image", {"imageBase64": "AAAA"}, ()),
        ("missing-checkpoint", {}, ("--checkpoint", str(evidence / "missing.pt"))),
    ]
    for name, changes, args in invalid_cases:
        request = {"imagePath": str(SOURCE), "bbox": [357, 56, 420, 127], **changes}
        response, execution = invoke(evidence, name, request, args, expected_ok=False)
        if name == "missing-checkpoint":
            assert response["error"]["type"] == "FileNotFoundError"
            assert not (evidence / "missing.pt").exists()
        report["checks"].append({"name": name, "passed": True, "response": response, "execution": execution})
    report["passed"] = True
    (evidence / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"passed": True, "samples": 2, "additionalChecks": len(report["checks"]),
                      "report": str(evidence / "report.json")}), flush=True)


if __name__ == "__main__":
    main()
