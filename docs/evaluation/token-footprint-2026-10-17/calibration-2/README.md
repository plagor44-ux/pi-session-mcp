# Preserved second qualified calibration

Source `sha256:a1596b99abd7fb9a4cf4c1c2c34edc3658681eb15bec67a39e7a78b0dfddd44a`
passed 80 transport cases, 50 filter cases, ten report controls and 16 local
synthetic Codex clients (63 scripted HTTP requests). Both measurements retained
unchanged source/build bindings. All their rows passed. Five scripted client
sessions/turns closed, including registered server process-group observation.

This source also passed the full suite: 65 files, 1,495 tests passed, six skipped,
97.64 seconds; typecheck, CLI/server builds and existing schema checks passed.
This is development verification, not release or real-provider qualification.

Afterward, only `token-footprint-plan.ts`'s cleanup **description** changed. The
proposal had incorrectly advertised one 30-second cleanup cap. The implementation
uses separately bounded supervisor and registered-server waits; the corrected
plan lists their 60,500 ms configured sum and leaves a wall-clock hard cap null,
because process-table observation adds time. No execution code changed. A
transient reconstruction of the old metadata reproduced the exact source digest
above, verifying that this was the only source difference after the broad suite.

These measurements and all unapproved proposal files remain byte-identical here.
They are additional verification overhead, excluded from the final comparison.
The final source was remeasured separately; no earlier binding or approval was
silently transferred. The broad suite was not repeated for this metadata edit.
