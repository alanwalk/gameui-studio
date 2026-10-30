"""Offline quality regression using known layers, without SAM weights or APIs.

Run: python scripts/test-segmentation-refinement.py
The real-matting cases require the explicitly installed .data/matting/site.
"""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MATTING_SITE = ROOT / ".data" / "matting" / "site"
if MATTING_SITE.is_dir():
    sys.path.insert(0, str(MATTING_SITE))
sys.dont_write_bytecode = True

import numpy as np
from PIL import Image

from segment_refinement import clean_target_components, connected_components, inference_bounds, inference_rgb, prepare_output, refine_alpha


def known_layers():
    height, width = 64, 72
    y, x = np.indices((height, width))
    alpha = np.clip((21 - np.sqrt((x - 36) ** 2 + (y - 32) ** 2)) / 3 + 0.5, 0, 1)
    foreground = np.zeros((height, width, 3)) + [0.9, 0.2, 0.1]
    background = np.empty_like(foreground)
    background[:, :, 0] = 0.08
    background[:, :, 1] = 0.5 + 0.1 * x / width
    background[:, :, 2] = 0.8
    observed = alpha[:, :, None] * foreground + (1 - alpha[:, :, None]) * background
    rgba = np.dstack((np.rint(observed * 255).astype(np.uint8), np.full((height, width), 255, dtype=np.uint8)))
    return rgba, alpha, foreground, background


class SegmentationRefinementTests(unittest.TestCase):
    def test_hidden_transparent_rgb_cannot_change_the_model_input(self):
        first = np.array([[[255, 0, 255, 0], [220, 40, 90, 255], [200, 100, 20, 128]]], dtype=np.uint8)
        second = first.copy()
        second[0, 0, :3] = [0, 255, 0]
        np.testing.assert_array_equal(inference_rgb(first), inference_rgb(second))
        np.testing.assert_array_equal(inference_rgb(first)[0, 0], [127, 127, 127])
        np.testing.assert_array_equal(inference_rgb(first)[0, 1], first[0, 1, :3])
        np.testing.assert_array_equal(first[0, 2], [200, 100, 20, 128])

    def test_known_layers_improve_alpha_and_new_background_composites(self):
        rgba, alpha, foreground, _ = known_layers()
        coarse = alpha > 0.5
        output, returned_mask, details = refine_alpha(rgba, coarse, [], MATTING_SITE)
        self.assertEqual(details["status"], "applied", details)
        self.assertEqual(details["method"], "pymatting-cf")
        np.testing.assert_array_equal(returned_mask, coarse)
        estimated_alpha = output[:, :, 3] / 255
        estimated_foreground = output[:, :, :3] / 255
        boundary = (alpha > 0) & (alpha < 1)
        binary_error = np.abs(coarse - alpha)[boundary].mean()
        estimated_error = np.abs(estimated_alpha - alpha)[boundary].mean()
        self.assertLess(estimated_error, binary_error * 0.45)
        self.assertGreater(details["softAlphaPixels"], 100)
        self.assertGreater(details["changedRgbPixels"], 0)
        # Compare to known clean foreground on independent backgrounds. Re-overlay
        # on the observed screenshot would conceal colour contamination.
        for background in ([0, 0, 0], [1, 1, 1], [0.8, 0.05, 0.7]):
            background = np.asarray(background)
            expected = foreground * alpha[:, :, None] + background * (1 - alpha[:, :, None])
            refined = estimated_foreground * estimated_alpha[:, :, None] + background * (1 - estimated_alpha[:, :, None])
            baseline = rgba[:, :, :3] / 255 * coarse[:, :, None] + background * (~coarse[:, :, None])
            self.assertLess(np.abs(refined - expected)[boundary].mean(), np.abs(baseline - expected)[boundary].mean() * 0.5)

    def test_existing_alpha_and_foreground_are_preserved_including_tips(self):
        rgba, alpha, foreground, _ = known_layers()
        rgba[:, :, :3] = np.rint(foreground * 255).astype(np.uint8)
        rgba[:, :, 3] = np.rint(alpha * 255).astype(np.uint8)
        output, mask, details = refine_alpha(rgba, alpha > 0.75, [], MATTING_SITE)
        self.assertEqual(details["status"], "preserved")
        np.testing.assert_array_equal(output, rgba)
        np.testing.assert_array_equal(mask, rgba[:, :, 3] > 0)

    def test_output_recovers_prompt_clipping_but_excludes_distant_neighbor(self):
        rgba = np.zeros((64, 90, 4), dtype=np.uint8)
        rgba[20:40, 16:42] = [200, 60, 20, 255]
        rgba[19, 20:40] = [200, 60, 20, 96]
        rgba[25, 44] = [250, 180, 30, 180]  # Detached ornament near the target.
        rgba[22:35, 65:75] = [30, 150, 220, 255]  # Neighbor, fully outside prompt.
        prompt = [20, 20, 40, 40]
        roi = [4, 4, 82, 56]
        raw_mask = rgba[4:56, 4:82, 3] > 0
        binary, result, diagnostics = prepare_output(Image.fromarray(rgba), raw_mask, prompt, roi, [])
        np.testing.assert_array_equal(result[19:40, 16:45], rgba[19:40, 16:45])
        self.assertFalse(result[:, 65:75, 3].any())
        self.assertEqual(int(binary[25, 44]), 255)
        self.assertLess(diagnostics["outputBounds"][0], prompt[0])
        self.assertGreater(diagnostics["outputBounds"][2], prompt[2])
        self.assertEqual(diagnostics["quality"]["removedComponents"], 1)
        self.assertEqual(diagnostics["quality"]["status"], "review")

    def test_small_disconnected_details_survive_and_negative_island_is_removed(self):
        mask = np.zeros((32, 40), dtype=bool)
        mask[10:20, 10:20] = True
        mask[8, 12] = True
        mask[12:15, 26:29] = True
        prompt = [5, 5, 32, 24]
        selected, report = clean_target_components(mask, prompt, [{"x": 27, "y": 13, "label": 0}])
        self.assertTrue(selected[8, 12])
        self.assertTrue(selected[15, 15])
        self.assertFalse(selected[13, 27])
        self.assertEqual(report["removedComponents"], 1)
        diagonal = np.eye(5, dtype=bool)
        self.assertEqual(len(connected_components(diagonal)[1]), 1)

    def test_missing_matting_is_an_explicit_degradation(self):
        rgba, alpha, _, _ = known_layers()
        coarse = alpha > 0.5
        with patch("segment_refinement.load_matting", side_effect=ImportError("not installed")):
            result, _, details = refine_alpha(rgba, coarse, [])
        self.assertEqual(details["status"], "degraded")
        self.assertEqual(details["method"], "binary-mask")
        self.assertIn("PyMatting", details["reason"])
        np.testing.assert_array_equal(result[:, :, 3], coarse.astype(np.uint8) * 255)

    def test_nonfinite_solver_result_is_rejected(self):
        rgba, alpha, _, _ = known_layers()
        with patch("segment_refinement.load_matting", return_value=(
                lambda image, trimap, **kwargs: np.full(trimap.shape, np.nan),
                lambda image, matte: image)):
            result, _, details = refine_alpha(rgba, alpha > 0.5, [])
        self.assertEqual(details["status"], "degraded")
        self.assertIn("无效数值", details["reason"])
        self.assertTrue(np.isfinite(result).all())

    def test_prompt_points_keep_global_coordinates_and_roi_contact_is_reported(self):
        prompt = [30, 30, 50, 50]
        points = [{"x": 85, "y": 70, "label": 0}, {"x": 35, "y": 40, "label": 1}]
        roi = inference_bounds(prompt, 100, 90, points)
        self.assertLessEqual(roi[0], 30)
        self.assertGreater(roi[2], 85)
        self.assertGreater(roi[3], 70)
        rgba = np.zeros((80, 100, 4), dtype=np.uint8)
        rgba[30:50, 20:50] = [150, 60, 20, 255]
        roi = [20, 20, 70, 60]
        mask = rgba[20:60, 20:70, 3] > 0
        _, _, diagnostics = prepare_output(Image.fromarray(rgba), mask, prompt, roi,
                                           [{"x": 35, "y": 40, "label": 1}])
        self.assertEqual(diagnostics["quality"]["status"], "failed")
        self.assertIn("inference-edge-contact", [issue["code"] for issue in diagnostics["quality"]["issues"]])

    def test_empty_transparent_input_is_not_a_success(self):
        rgba = np.zeros((20, 20, 4), dtype=np.uint8)
        with self.assertRaisesRegex(ValueError, "可见像素"):
            prepare_output(Image.fromarray(rgba), np.ones((20, 20), dtype=bool), [2, 2, 18, 18], [0, 0, 20, 20], [])

    def test_a_single_transparent_hole_does_not_restore_the_flattened_background(self):
        rgba = np.full((40, 40, 4), 255, dtype=np.uint8)
        rgba[0, 0, 3] = 0
        mask = np.zeros((40, 40), dtype=bool)
        mask[12:22, 12:22] = True
        result, support, details = refine_alpha(rgba, mask, [])
        np.testing.assert_array_equal(support, mask)
        np.testing.assert_array_equal(result[:, :, 3], mask.astype(np.uint8) * 255)
        self.assertIn("排除区域", details["reason"])

    def test_native_alpha_bridge_cannot_restore_a_removed_or_negative_neighbor(self):
        rgba = np.zeros((40, 64, 4), dtype=np.uint8)
        rgba[10:25, 10:25] = [230, 90, 30, 255]
        rgba[10:25, 45:55] = [30, 160, 240, 255]
        rgba[18, 25:45] = [130, 150, 170, 1]
        points = [{"x": 16, "y": 16, "label": 1}, {"x": 50, "y": 16, "label": 0}]
        binary, result, diagnostics = prepare_output(Image.fromarray(rgba), rgba[:, :, 3] > 128,
                                                    [10, 10, 25, 25], [0, 0, 64, 40], points)
        self.assertFalse(result[:, 45:55, 3].any())
        self.assertFalse(binary[:, 45:55].any())
        self.assertEqual(int(result[16, 16, 3]), 255)
        self.assertEqual(diagnostics["quality"]["removedComponents"], 1)
        self.assertIn("native-alpha-limited", [issue["code"] for issue in diagnostics["quality"]["issues"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
