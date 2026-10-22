"""Run dark-feature screening on a supplied calibrated SAR GeoTIFF."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .sar import DetectionInputError, detect_sar_dark_features


def main() -> int:
    parser = argparse.ArgumentParser(description="Screen a Sentinel-1 SAR GeoTIFF for possible dark slick features.")
    parser.add_argument("scene", type=Path, help="Calibrated sigma0 backscatter GeoTIFF in dB")
    parser.add_argument("--acquired-at", required=True, help="Scene acquisition time with UTC offset, e.g. 2026-10-17T09:30:00Z")
    parser.add_argument("--provider", required=True, help="Actual imagery provider; do not use an invented source")
    parser.add_argument("--dataset", required=True, help="Product identifier or dataset/version")
    parser.add_argument("--water-mask", type=Path, help="Optional aligned water mask GeoTIFF; pixels greater than zero are water")
    parser.add_argument("--band", type=int, default=1, help="GeoTIFF band number (default: 1)")
    parser.add_argument("--polarization", default="VV", help="SAR polarization represented by the selected band")
    parser.add_argument("--output", type=Path, help="Optional path for the resulting detection JSON")
    args = parser.parse_args()

    try:
        result = detect_sar_dark_features(
            args.scene,
            acquired_at=args.acquired_at,
            source={"provider": args.provider, "dataset": args.dataset, "file_name": args.scene.name},
            band=args.band,
            polarization=args.polarization,
            water_mask_path=args.water_mask,
        )
    except DetectionInputError as exc:
        parser.error(str(exc))

    rendered = json.dumps(result, indent=2, ensure_ascii=False)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
