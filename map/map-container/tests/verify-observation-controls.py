"""Independent geometry oracle over frozen SDK/PNG observations; lead-owned.

This measures synthetic marker alignment in CSS pixels, not map accuracy,
imagery acquisition accuracy, object detection, or model understanding.
"""

import argparse
import hashlib
import json
import math
import struct
from pathlib import Path


EXPECTED_CASES = {
    "dpr1": (1, 0, (0, 0, 0, 0)),
    "dpr2": (2, 0, (0, 0, 0, 0)),
    "dpr2-rotated-padded": (2, 31, (17, 43, 29, 71)),
}
EXPECTED_POINTS = [
    ([116.30, 39.83], [229, 59, 53]),
    ([116.50, 39.84], [49, 163, 94]),
    ([116.31, 39.97], [51, 107, 199]),
    ([116.49, 39.96], [226, 173, 32]),
    ([116.40, 39.90], [178, 71, 168]),
]
THRESHOLD_CSS_PX = 1.0
WEB_MERCATOR_RADIUS = 6_378_137.0


def number(value):
    assert not isinstance(value, bool) and isinstance(value, (int, float)), value
    assert math.isfinite(value), value
    return float(value)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def png_dimensions(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert data[8:16] == b"\x00\x00\x00\rIHDR"
    return struct.unpack(">II", data[16:24])


def world(wgs84, wkid):
    longitude, latitude = map(number, wgs84)
    if wkid == 4326:
        return longitude, latitude
    assert wkid in (3857, 102100, 102113), wkid
    assert -85 < latitude < 85
    return (
        WEB_MERCATOR_RADIUS * math.radians(longitude),
        WEB_MERCATOR_RADIUS * math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2)),
    )


def measure(capture, points, png, pixels=None):
    image = capture["imageSize"]
    width, height = png_dimensions(png)
    assert (width, height) == (image["width"], image["height"])
    rect = capture["mapContentRect"]
    css = capture["cssViewSize"]
    assert number(css["width"]) > 0 and number(css["height"]) > 0
    assert 0 <= rect["x"] < rect["x"] + rect["width"] <= width
    assert 0 <= rect["y"] < rect["y"] + rect["height"] < height, "attribution footer is absent"
    sx = number(rect["width"]) / number(css["width"])
    sy = number(rect["height"]) / number(css["height"])
    geo = capture["georeference"]
    assert geo["kind"] == "affine-2d", geo
    assert geo["wkid"] == capture["camera"]["wkid"]
    assert capture["camera"]["mode"] == "map"
    a, b, c, d, e, f = map(number, geo["coefficients"])
    determinant = a * e - b * d
    assert math.isfinite(determinant) and determinant != 0
    observations = []
    for index, point in enumerate(points):
        x, y = world(point["wgs84"], geo["wkid"])
        # Invert the recorded image-to-world affine; do not use capture-math.
        u = (e * (x - c) - b * (y - f)) / determinant
        v = (-d * (x - c) + a * (y - f)) / determinant
        predicted = ((u - rect["x"]) / sx, (v - rect["y"]) / sy)
        screen = point["screen"]
        actual = (number(screen["x"]), number(screen["y"]))
        assert 0 < actual[0] < css["width"] and 0 < actual[1] < css["height"]
        residual = math.dist(predicted, actual)
        assert residual <= THRESHOLD_CSS_PX, (index, "affine-to-SDK", residual)
        row = {"wgs84": point["wgs84"], "affineToSdkCssPx": residual}
        if pixels is not None:
            marker = pixels[index]
            assert marker["index"] == index and marker["color"] == point["markerColor"]
            assert isinstance(marker["count"], int) and marker["count"] >= 50, marker
            centroid = marker["centroid"]
            observed = (
                (number(centroid["x"]) - rect["x"]) / sx,
                (number(centroid["y"]) - rect["y"]) / sy,
            )
            affine_to_png = math.dist(predicted, observed)
            png_to_sdk = math.dist(observed, actual)
            assert affine_to_png <= THRESHOLD_CSS_PX, (index, "affine-to-PNG", affine_to_png)
            assert png_to_sdk <= THRESHOLD_CSS_PX, (index, "PNG-to-SDK", png_to_sdk)
            row.update({
                "affineToPngCssPx": affine_to_png,
                "pngToSdkCssPx": png_to_sdk,
                "markerPixels": marker["count"],
            })
        observations.append(row)
    return {
        "points": observations,
        "maxAffineToSdkCssPx": max(row["affineToSdkCssPx"] for row in observations),
        **({} if pixels is None else {
            "maxAffineToPngCssPx": max(row["affineToPngCssPx"] for row in observations),
            "maxPngToSdkCssPx": max(row["pngToSdkCssPx"] for row in observations),
        }),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--controls", type=Path, required=True)
    parser.add_argument("--pixels", type=Path, required=True)
    parser.add_argument("--composition", type=Path)
    parser.add_argument("--composition-png", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = read_json(args.controls)
    pixel_source = read_json(args.pixels)
    assert source["schemaVersion"] == pixel_source["schemaVersion"] == 1
    assert source["sdkVersion"] == "5.1.24"
    assert sorted(case["name"] for case in source["cases"]) == sorted(EXPECTED_CASES)
    assert sorted(case["name"] for case in pixel_source["cases"]) == sorted(EXPECTED_CASES)
    pixels_by_case = {case["name"]: case for case in pixel_source["cases"]}
    results = []
    for case in source["cases"]:
        dpr, rotation, padding = EXPECTED_CASES[case["name"]]
        assert number(case["devicePixelRatio"]) == dpr
        camera = case["sdkCamera"]
        assert math.isclose(number(camera["rotation"]), rotation, abs_tol=1e-8)
        assert tuple(camera["padding"][key] for key in ("top", "right", "bottom", "left")) == padding
        assert case["capture"]["cssViewSize"] == {"width": camera["width"], "height": camera["height"]}
        assert len(case["controlPoints"]) == len(EXPECTED_POINTS)
        for point, (position, color) in zip(case["controlPoints"], EXPECTED_POINTS):
            assert point["wgs84"] == position and point["markerColor"] == color
        png = (args.controls.parent / case["png"]["path"]).read_bytes()
        pixels = pixels_by_case[case["name"]]
        assert digest(png) == case["png"]["sha256"] == pixels["sha256"]
        assert (pixels["width"], pixels["height"]) == png_dimensions(png)
        assert [marker["index"] for marker in pixels["markers"]] == list(range(len(EXPECTED_POINTS)))
        results.append({
            "name": case["name"],
            **measure(case["capture"], case["controlPoints"], png, pixels["markers"]),
        })
    if args.composition is not None:
        assert args.composition_png is not None
        app = read_json(args.composition)
        png = args.composition_png.read_bytes()
        assert app["record"]["callId"] == "obs-labelled" and app["record"]["mapRevision"] == 2
        assert digest(png) == app["record"]["attachment"]["sha256"]
        results.append({
            "name": "session-composition",
            **measure(app["record"], app["controlPoints"], png),
        })
    verdict = {
        "schemaVersion": 1,
        "status": "passed",
        "thresholdCssPx": THRESHOLD_CSS_PX,
        "verifierSha256": digest(Path(__file__).read_bytes()),
        "controlsSha256": digest(args.controls.read_bytes()),
        "pixelObservationsSha256": digest(args.pixels.read_bytes()),
        "cases": results,
    }
    args.output.write_text(json.dumps(verdict, indent=2) + "\n")
    print(json.dumps(verdict, indent=2))


if __name__ == "__main__":
    main()
