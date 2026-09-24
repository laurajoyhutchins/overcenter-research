# Overcenter documentation

This directory is the bridge between Overcenter's architecture and its executable interfaces. The root README states the research claim; `ARCHITECTURE.md` defines the cross-cutting model; these documents explain how to operate, extend, recover, and deploy the current implementation.

## Start here

| Need | Document |
| --- | --- |
| verify a checkout and understand the live operator loop | [`getting-started.md`](./getting-started.md) |
| declare project work | [`project-intent.md`](./project-intent.md) |
| use the supported semantic commands | [`operator-commands.md`](./operator-commands.md) |
| add or assess a provider effect | [`providers.md`](./providers.md) |
| handle uncertain or interrupted work | [`recovery.md`](./recovery.md) |
| understand source-change work and evidence admission | [`source-work.md`](./source-work.md) |
| understand READY selection and fairness assumptions | [`scheduling.md`](./scheduling.md) |
| assemble the production execution/trust boundaries | [`deployment.md`](./deployment.md) |
| understand durable evidence and disposable telemetry | [`evidence.md`](./evidence.md) |
| diagnose fail-closed errors | [`troubleshooting.md`](./troubleshooting.md) |
| reason about adapter ambiguity | [`adapter-diagnosability.md`](./adapter-diagnosability.md) |
| review durable architecture choices | [`adr/`](./adr/README.md) |

## Documentation authority

Documentation explains authority; it does not create authority. When prose and executable machinery disagree, treat the executable contract, admitted production tests, and exact source revision as the operative boundary and repair the prose.

Keep the layers separate:

    architecture        why the boundaries exist
    ADRs                durable choices made from evidence
    contracts           cross-language and persisted data boundaries
    operator docs       supported human/agent interactions
    provider docs       extension and recovery obligations
    experiments         bounded evidence, including negative results
    formal models       explicitly scoped machine-checked claims

Do not turn an experiment README into a second production manual. Once a result is promoted, the production source, regression tests, ADRs, and these interface documents should describe the maintained behavior.
