# A/B technical probe, attempt 1 (2026-10-18): FAIL, environment

Operator approval on 2026-10-18: option C of #93, one pair (arm A, then arm B),
Codex 0.162.1 controller with Sol, worker skills selected in both arms, 10 USD
operator-selected advisory (not a cap), unmetered subscription use acknowledged.
The approved copies bound here are those of arm A (commit `e905506`: the
Sprint 5 harness with `skills/` and `src/server.ts` of `612fbcb`).

| Arm | Result | Starts | Work turns |
| --- | --- | ---: | ---: |
| A | **FAIL** in L1: `pi_session_start` returned a domain error, the controller stopped as instructed | 1 | 0 |
| B | not run (stop rule) | 0 | 0 |

Cause, reproduced afterwards with the same case configuration and without a
model request: `local_authentication_missing`. The M1 worker routes use the Pi
provider `openai-codex`, which has no local login on this workstation; its Pi
profiles use `openai`. The pilot ran on another machine (Node 22.23.2 there,
26.11.1 here). The integrator did not check route availability on this machine
before the run. Source, build, controller-skill and worker-skill rechecks passed;
the controller exited 0; proxy integrity held; server and controller cleanup
were observed.

Not a harness defect and no evidence about the A/B question. No retry was made
within this approval; a new run needs a route that exists on the executing
machine and its own approval.
