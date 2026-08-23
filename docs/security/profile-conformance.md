# Execution-profile conformance

This document is generated conceptually from the checked-in golden manifest at
`tests/fixtures/profile-conformance-golden.json`. The manifest is authoritative;
the marker-delimited table below is deterministically rendered and byte-compared
in the test suite.

<!-- PROFILE-CONFORMANCE:START -->
| Profile | Namespaces | Capabilities | Side effects | Tiers | Scopes | Approval declarations |
|---|---|---|---|---|---|---|
| read_only | * | read | none | LOCAL_EDGE | path=none, network=none | write=false, exec=false, send=false |
| workspace_write | filesystem | read, write | none, filesystem_write | LOCAL_EDGE, FRONTIER | path=workspace, network=none | write=true, exec=false, send=false |
| browser_research | browser, playwright, research | read | none | LOCAL_EDGE, FRONTIER | path=none, network=browser | write=false, exec=false, send=false |
| terminal_power | desktop_commander, sandbox, shell, terminal | read, write, exec | none, process | LOCAL_EDGE, FRONTIER | path=configured, network=configured | write=true, exec=true, send=false |
| agent_conversation | collab | read | none, collab_write | LOCAL_EDGE | path=none, network=none | write=false, exec=false, send=false |
<!-- PROFILE-CONFORMANCE:END -->

## Scope and claims

The executable scope is the TypeScript gateway/bridge and LOCAL_EDGE execution
path. FRONTIER/Hermes is excluded. The suite does not exercise a browser UI;
browser and Playwright are registry provenance values tested through the real
resolver and classifier.

`scopes.network` is declaration and hash material. It is not consulted by
`executeTool`, so this suite makes no claim that it is a pre-execution network
fence and it is not a network containment guarantee.

Profile approval requirements are also declaration and hash material; they are
not execution-pause authority. `RegisteredTool.requiresApproval` is separate live
registry metadata. The LOCAL_EDGE loop's actual pause behavior is outside these
declarative equality tests; the suite checks only the exact resolved approval
map and its contribution to the policy hash.

Path checks cover arguments extracted by `extractPaths`, including configured
`pathArgKeys`. A nonstandard path key without a hint is deliberately missed.
No arbitrary shell/process containment claim follows from filesystem path
checks.

## Executable evidence map

- AC-1: exact four-profile manifest equality plus this table's byte equality.
- AC-2: raw tool identifiers, exact classifier inputs, outputs, scope modes,
  derived side effects, and both browser/Playwright provenance.
- AC-3/4: namespace + capability + derived-side-effect conjunction over frozen
  synthetic `RegisteredTool` snapshots, including positive/negative exposure.
- AC-5: real `executeTool` pre-client denials, stale re-resolution, and admitted
  reachability to the actual `No MCP client connected` boundary.
- AC-6/7: LOCAL_EDGE tier rewrite/tool filtering and the seven bounded path cases.
- AC-C2: literal canonical preimage/SHA vector, material sensitivity, stale
  policy, and the real in-memory SQLite approval-writer decision path.
- AC-10A: compiler-API AST inventory of production TypeScript caller surfaces.
- AC-11: declarative network and approval limitations above.
