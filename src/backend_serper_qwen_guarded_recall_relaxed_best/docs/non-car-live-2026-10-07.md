# Non-car live benchmark — 2026-10-07

The six Brazil inputs are saved in `tests/non_car_live_cases.js`. Full responses
are in `tests/fixtures/non_car_live_2026_10_07/`; that folder also holds the
Marcopolo progress log. These are historical observations, not an approved
factory-color reference set. Some outputs have only maker-wide applicability.

| Vehicle | Time | AI + Serper upper bound | Searches failed | Pages fetched / fetch errors | Colors | Completion |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Honda CG 160 2020, red motorcycle | 26.1 s | $0.020831 | 0 / 10 | 14 / 6 | 1 | Complete |
| Volvo FH 540 2022, white truck | 47.5 s | $0.023349 | 0 / 14 | 6 / 5 | 4 | Partial: model link and names unresolved |
| Marcopolo Paradiso 1200 G7 2018, white bus | 25.8 s | $0.011497 | 0 / 10 | 0 / 10 | 0 | Failed: research fetch |
| Massey Ferguson 275 1980, red tractor | 38.7 s | $0.022197 | 0 / 12 | 9 / 4 | 1 | Partial: model link and discovery |
| Caterpillar 320 2020, yellow excavator | 51.0 s | $0.028675 | 0 / 12 | 11 / 7 | 1 | Partial: model link |
| Mercedes-Benz Sprinter 415 2018, white minibus | 58.0 s | $0.037593 | 0 / 17 | 14 / 10 | 7 | Partial: model link |

Combined upper bound was **$0.144142**. All **75** searches succeeded; **42**
page fetch attempts failed. Five vehicles returned at least one comparison
candidate. Only the Honda run reported complete processing. A returned candidate
or a complete processing status does not prove factory applicability.

## Re-run later

```bash
npm --prefix backend_serper_qwen_guarded run test:non-cars -- --list
npm --prefix backend_serper_qwen_guarded run test:non-cars -- --run marcopolo-paradiso
npm --prefix backend_serper_qwen_guarded run test:non-cars -- --run all
```

`--run` is required for paid calls. Runs are sequential and save raw responses,
progress events, and a summary under `backend_serper_qwen_guarded/tmp/non-car-live/`.
The simple pass check means only that at least one color and one fetched research
page exist and the run did not fail. Review model/year, finish, code, and source
claims separately before treating any result as accurate.

## Marcopolo failure details

The search service returned results on every query and indexed 53 source URLs.
The initial filter admitted only two paint-context pages, both on Scribd; each
timed out twice under the 5-second page budget. Recovery tried four Marcopolo
URLs; two returned HTTP 403 immediately, one timed out then returned 403, and
one timed out twice. No source page was fetched and no paint name could be grounded.

The filter checks the compact *whole* model string `paradiso1200g7` in a result.
Real pages often use `Paradiso New G7 1200`, which has the same model tokens in
a different order. Those pages can be discarded before fetch. The selector also
admits two hard-to-fetch document pages ahead of more accessible sources.
Search snippets and image/livery listings should not be promoted to confirmed
paint names merely to fill the response.

## Follow-up implementation

The guarded backend now accepts reordered tokens of longer numbered models
through source selection, display-color discovery, model-linked page checks and
final verification. Exact model numbers and generations still have to match.
Model-specific specialist listings with printed hue words such as `branco` or
`white` can now enter discovery as lower-priority leads; they are not accepted
as factory paint evidence without extraction and review.
Discovery deprioritizes reader-gated document hosts, limits specialist fetches
to two URLs per unproven host in one selection wave, and stops choosing a host after a
403 or two failed fetches unless that host has yielded a readable page. A full
page timeout no longer triggers a second 5-second fetch of the same URL.
Bus-specific prompts and verification distinguish body paint from chassis paint
and operator livery. The table above remains the pre-patch baseline; the single
post-patch Marcopolo run is recorded below.

## Post-patch Marcopolo live run

One paid Marcopolo rerun completed on 2026-10-07 in **10.26 s** with an AI plus
Serper upper bound of **$0.012748**. All **10** searches succeeded; **4** pages
were fetched and **1** fetch failed. This improved the original 0/10 fetch
result, but the run still **failed** with `No source-grounded named paint
candidates found`. The fetched pages were two technical parts catalogs, one
Pinterest model image page and a 2012 used-bus listing. None supplied a named
2018 body paint. BASF model discovery returned zero rows. The full response,
events and summary are in
`tmp/non-car-live/2026-10-07T11-49-43-263Z/` inside this backend. This result
does not validate color recall or factory applicability for Marcopolo.
