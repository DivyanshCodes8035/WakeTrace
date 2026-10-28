# WakeTrace product ideas

This file tracks proposed work and implementation status.

## Next implementation priority — Monday, 26 October 2026

**Status: prototype implemented.** The planner builds a forecast what-if envelope and queries nearby OpenStreetMap coastal features, recording source and uncertainty details. NOAA's [published ESI availability catalog](https://response.restoration.noaa.gov/download-esi-maps-and-gis-data) does not list Mauritius, the project's demonstration area, so this build does not claim or draw NOAA ESI coverage there. If a future demonstration area has NOAA ESI coverage, verify the exact atlas and date before using it; otherwise continue to show the actual alternative dataset and any coverage gaps.

## 1. Coastal Impact Planner — prototype implemented; validation and richer data coverage remain

**Question answered:** If a possible slick keeps drifting, which coastal places could be affected, and when might responders need to pay attention?

- Overlay locally sourced sensitive places such as beaches, reefs, mangroves, protected areas, and water intakes.
- Run multiple plausible drift scenarios and show an impact range and estimated arrival-time window, with uncertainty visible.
- Produce a short response-priority card explaining which locations to watch first and why.
- Treat outputs as decision support; do not present them as guaranteed impact predictions or response orders.

**Visible demo change:** After the drift step, the map highlights potentially exposed coast segments and the interface lists the highest-priority places with the data source and uncertainty.

## 2. Multi-pass Spill Verification

**Question answered:** Does the same possible slick appear to evolve like a real moving surface slick across available satellite observations, or could it be a one-image look-alike?

- Search for Sentinel-1 observations before and after the selected scene when available.
- Align the image footprints and let the user compare them with a time slider or side-by-side view.
- Track whether a candidate's location and shape change in a way consistent with the observed wind/current context.
- Show a plain-language status such as “seen in one pass,” “seen in multiple passes,” or “inconclusive,” with dates and missing-data gaps.
- Keep the result as supporting evidence: repeat imagery can strengthen review, but does not by itself prove the substance is oil.

**Visible demo change:** A judge can move through real, timestamped satellite observations and see the same candidate followed over time, with the model's reasoning and uncertainty beside the imagery.

## Practical prerequisites

- Confirm the relevant scene is available for the chosen area and dates; satellite revisit timing and cloud conditions can leave gaps.
- Source and verify local coastal sensitivity data before ranking real locations.
- Keep real observations, synthetic practice scenes, model outputs, and analyst conclusions visibly distinct.
