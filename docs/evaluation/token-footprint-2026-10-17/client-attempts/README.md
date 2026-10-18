# Preserved synthetic client attempts

These are newly generated local Codex 0.162.0 runs against the declared scripted
loopback Responses endpoint. They made no worker/provider model request and have
no usable model token or money measurement. No historical client log was read.
Raw client state was disposable; only allowlisted metrics were retained.

| Record | Fresh clients | Outcome retained |
| --- | ---: | --- |
| [pilot-1.json](pilot-1.json) | 1 | INCONCLUSIVE: fixture function calls omitted the current tool namespace; no successful MCP projection qualification. |
| [pilot-2.json](pilot-2.json) | 1 | INCONCLUSIVE: namespace fixed and marker observed, but proxy metrics and process cleanup not established. |
| [pilot-3.json](pilot-3.json) | 1 | INCONCLUSIVE: both process groups cleaned; normal client shutdown signal incorrectly invalidated transport integrity. |
| [attempt-4.json](attempt-4.json) | 16 | All rows passed, including the pilot and five repetitions of each of three cases; overall INCONCLUSIVE because measurement sources changed during the attempt. |

The fourth attempt made 63 scripted HTTP requests. The three preceding pilots
made three requests each. These 19 clients and 72 requests are additional
calibration overhead, excluded from the final source-frozen client comparison.
Attempt four created five scripted sessions/turns; all closed and both owned
process groups were observed terminated. The failed earlier cleanup observations
remain failed; a later `/proc` scan found no surviving owned fixture command.
They are not silently upgraded to PASS.

Client projection conclusions require the separate source-frozen replay.
The earlier records lack later fields and retain their original source/build
bindings and literal bytes. Never reuse their bindings as approval for M1.
