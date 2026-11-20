"""Check newly captured app geometry while reusing the frozen SDK verdict."""

import argparse
import importlib.util
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    oracle_path = Path(__file__).resolve().parents[2] / "map-container/tests/verify-observation-controls.py"
    spec = importlib.util.spec_from_file_location("observation_geometry_oracle", oracle_path)
    oracle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(oracle)
    evidence = args.evidence.resolve()
    sdk_path = evidence / "sdk-controls-aspect/verification.json"
    sdk = oracle.read_json(sdk_path)
    assert sdk["status"] == "passed" and sdk["thresholdCssPx"] == oracle.THRESHOLD_CSS_PX
    assert sdk["verifierSha256"] == oracle.digest(oracle_path.read_bytes())

    cases = []
    for name, directory in (("recording", evidence), ("replay", evidence / "replay")):
        controls_path = directory / "observation-session-controls.json"
        app = oracle.read_json(controls_path)
        record = app["record"]
        receipt = app["renderReceipt"]
        png = (directory / "map-observation-labelled.png").read_bytes()
        assert record["callId"] == "obs-labelled" and record["mapRevision"] == 2
        assert receipt["status"] == "rendered" and receipt["renderedRevision"] == 2
        assert (receipt["viewId"], receipt["generation"]) == (record["viewId"], record["generation"])
        assert oracle.digest(png) == record["attachment"]["sha256"]
        assert [point["wgs84"] for point in app["controlPoints"]] == [
            position for position, _color in oracle.EXPECTED_POINTS
        ]
        cases.append({
            "name": name,
            "controlsSha256": oracle.digest(controls_path.read_bytes()),
            "pngSha256": record["attachment"]["sha256"],
            **oracle.measure(record, app["controlPoints"], png),
        })
    result = {
        "schemaVersion": 1,
        "status": "passed",
        "thresholdCssPx": oracle.THRESHOLD_CSS_PX,
        "sdkVerificationSha256": oracle.digest(sdk_path.read_bytes()),
        "verifierSha256": oracle.digest(Path(__file__).read_bytes()),
        "cases": cases,
    }
    output = evidence / "observation-app-controls-verification.json"
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
