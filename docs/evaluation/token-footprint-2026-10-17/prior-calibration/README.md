# Preserved first calibration binding

This first successful M0 attempt ran on source digest
`sha256:4700852ad8e150c1985604bb1e2951dc43db2b1ea511e26314151712bc3a25dc`.
Its 80 transport cases, 50 filter cases and ten adverse report controls passed.
The same source passed 1,477 tests with six skipped and its builds/schema check.
The parent dossier's `baseline.json`, `measurement.json`, `summary.json`,
`live-proposal.json` and `checks.json` remain byte-identical, including failures during
implementation and the then-missing executable M1 driver.

Later development added the narrowly gated M1 executor, per-tool schema sizes,
and actual fixture instruction text to M0's control envelope. The prior 41-byte
prompt measurement described only the control envelope. The new current-source
calibration is separate; no earlier qualification or approval transfers. This
attempt is additional measurement/verification overhead, excluded from the later
baseline/candidate table. It made no external worker provider request.

The copied original `integrity.json` binds the artifact bytes it originally
listed; its earlier parent README/follow-up texts are not recreated here. The
parent dossier's current integrity index also binds every retained file here.
