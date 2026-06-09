# Fixtures

**Synthetic data only.** Nothing in this directory may contain, or be derived
from, real location history.

Rules for any fixture added here:

- Coordinates must be invented (this project uses a tiny grid near `0,0`),
  never real coordinates and never real coordinates that were shifted,
  rounded, offset, simplified, or otherwise transformed — derived data can
  still leak route shapes and movement patterns.
- Timestamps must be fake (this project uses ISO week `2000-W01`).
- Place/track names must be obviously fictional (`Synthetic Place Alpha`).
- Category/type values may mirror real Arc categories (`walking`, `metro`,
  `bogus`, …) because they are generic, non-identifying labels.

`2000-W01-synthetic.gpx` was hand-authored from the Arc Timeline GPX *schema*
(element structure, attribute names, value formats — see
`docs/arc-gpx-schema.md`) and doubles as a stress fixture: it contains an
empty segment, a multi-segment track, duplicate points, an impossible-speed
spike, an out-of-range coordinate, a `bogus` category, and an unknown
category, so parser and cleaning tests all run against it.

The repository `.gitignore` blocks `*.gpx` everywhere except fixture
directories; real exports must live outside the repository entirely.
