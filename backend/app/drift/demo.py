"""Run a clearly synthetic end-to-end example of the WakeTrace drift module.

This example uses artificial constant wind/current and an invented slick
polygon. Its output must not be treated as an observed event or used as a case.
Run from ``backend`` with ``python -m app.drift.demo``.
"""

from __future__ import annotations

import json

from opendrift.readers import reader_constant

from app.drift import estimate_origin


def main() -> None:
    # Synthetic, fixed environmental values for exercising the code path only.
    reader = reader_constant.Reader(
        x_wind=0.0,
        y_wind=0.0,
        x_sea_water_velocity=0.12,
        y_sea_water_velocity=0.03,
    )
    drift = estimate_origin(
        {
            "type": "Polygon",
            "coordinates": [[
                [-0.01, 0.00], [0.01, 0.00], [0.01, 0.01],
                [-0.01, 0.01], [-0.01, 0.00],
            ]],
        },
        "2024-01-01T12:00:00Z",
        readers=[reader],
        input_sources=[{
            "provider": "synthetic example only",
            "dataset": "OpenDrift constant reader",
            "description": (
                "Invented slick near [0, 0] and artificial constant forcing; "
                "wind=(0, 0) m/s, current=(0.12, 0.03) m/s. Not observed data."
            ),
        }],
        backtrack_hours=6,
        ensemble_size=20,
        time_step_seconds=900,
        random_seed=42,
    )
    print(json.dumps({
        "example_kind": "synthetic_demonstration_only_not_case_data",
        "drift": drift,
    }, indent=2))


if __name__ == "__main__":
    main()
