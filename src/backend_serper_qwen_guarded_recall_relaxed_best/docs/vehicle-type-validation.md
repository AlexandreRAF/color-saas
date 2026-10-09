# Vehicle-type validation checkpoint

The backend accepts free-form `automobileType`. Search profiles cover cars,
motorcycles, trucks, buses, agricultural and construction equipment. Unknown
types use general vehicle terms. Paint admission still depends on each source's
model/year evidence, not the profile.

## Checks completed

- Offline suite: 657 tests passed after the motorcycle display-color and trim
  fixes. Targeted profile, year-scope, model-scope and web-code checks passed.
- Honda CG 160, 2020, red, Brazil: 33.9 s, 11 successful Serper searches,
  $0.024581 total upper cost. Returned `Vermelho Perolizado` from two sources
  as a `vehicle_display_color`, with no invented code. That live run also
  exposed a trim artifact and compound label; both were patched afterward and
  validated offline, but not repeated live.
- Massey Ferguson 275, 1980, red, Brazil: 38.5 s, $0.022613 upper cost.
  Returned `Massey Ferguson Red` from two sources. Discovery reported partial
  coverage; source diversity was insufficient.
- Caterpillar 320, 2020, yellow, Brazil: two runs of about 38.3 s and
  $0.021361/$0.024654 upper cost. Both reported no supported model-linked
  paint. Sources included a maker-wide paint catalog, but no fetched passage
  established an individual color for that model and year. Search terms were
  tightened after the first run; the second still failed. Later equipment
  source filtering was checked offline only.

## Release status

The guarded copy now has a fleet-standard path with two separate source claims,
source-based depth for sparse specialist palettes, and exact catalog lookup
for generic display labels. The older live results above are historical.
The post-patch offline suite passed 661 tests across 67 files. A replay of the
saved Caterpillar evidence did not satisfy the new fleet-standard rule: those
pages still lacked a paint-specific, model-applicable standard-use claim.

Three sequential live checks of this patch used 28 browser uses and an
estimated combined AI plus Serper upper bound of $0.071183. No broad vehicle
suite was run:

| Vehicle | Time | Cost upper bound | Browser uses (failed) | Output | Limitation |
| --- | ---: | ---: | ---: | --- | --- |
| Caterpillar 320, 2020, yellow | 38.1 s | $0.025087 | 8 (0) | `Amarelo Caterpillar`, codes `05460` and `06461` | Only a maker paint product page was cited; final verification left model, year, codes and finish unknown. This did **not** use the fleet-standard bridge. |
| Massey Ferguson 275, 1980, red | 34.9 s | $0.021249 | 10 (1) | `Massey Ferguson Red`, no code | Sparse-source coverage completed; final verification left model and year unknown. |
| Honda CG 160, 2020, red | 31.4 s | $0.024847 | 10 (0) | `Vermelho Perolizado`, no code, `vehicle_display_color` | Name/model/year were confirmed; an independent finish specification was not found. |

The full responses and progress logs are at `tmp/cat320-live-guarded.*`,
`tmp/massey275-live-guarded.*`, and `tmp/cg160-live-guarded.*`.

**Not certified for mission-critical production across vehicle types.** The
construction and agricultural live outputs lack confirmed model/year paint
applicability, despite completing their processing stages. Trucks and buses
still have no live validation in this checkpoint. A release needs representative
multi-type ground-truth cases, concurrent load checks, and an explicit policy
for maker-wide paints whose model applicability remains unknown.

## Accuracy follow-up

A later Caterpillar 320 verification run took **50.55 s**, used **15 Serper
searches** with none failed, and had a **$0.032831** combined upper cost. Its
five final research queries still found no source that linked any paint to the
320. Six colors were returned, all with vehicle/year unknown; two were
extraction artifacts: a thumbnail linking to a different paint and a retailer
coating product title. The response is in `tmp/cat320-accuracy-live.json`.

The subsequent programmatic accuracy patch rejects those two artifacts and
adds `applicabilityScope` to every final color. Replaying the saved source
inventory classified all six prior names as `manufacturer_only`, so the new
response would flag `no_model_linked_colors` rather than imply a confirmed
model palette. The four remaining maker-wide paints remain comparison leads.
This patch adds no paid calls to a production request. The initial full offline
suite passed **670 tests across 68 files** after the last product-title filter.
These checks still do not establish
a Caterpillar 320 factory palette.

One subsequent live Caterpillar 320 run of this patch completed in **52.1 s**,
using **14 Serper searches** (none failed) and **$0.031077** total upper cost.
All three final colors were marked `manufacturer_only`; completion correctly
reported `no_model_linked_colors`. Verification confirmed the name and code
`06461` for `Amarelo Caterpillar`, but left vehicle, year and finish unknown.
The other two names were `Caterpillar Tractor Yellow` and a newly exposed
retailer title, `Tinta Amarela Brasilux Moderno Caterpillar Ano 95`. The latter
was added to the product-title filter afterward and checked offline. No second
paid run was made after this last filter. The live result and progress log are
at `/tmp/cat320-accuracy-final.json` and `/tmp/cat320-accuracy-final.log`.
