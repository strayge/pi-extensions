# Upstream provenance

This package is derived from `@narumitw/pi-worktree` 0.51.8 by narumitw,
from <https://github.com/narumiruna/pi-extensions/tree/87f29eaff190925d682927c5ff9b6e042e661bbb/packages/pi-worktree>.

Baseline source: upstream commit `87f29eaff190925d682927c5ff9b6e042e661bbb`.
The baseline `src/` is identical to the installed npm package's source.
The upstream MIT license is retained in `LICENSE`.

Source and behavior tests were imported, with relative TypeScript imports adapted
for this repository's source-only loader and Node test runner. The generated
runtime and its build-only test are intentionally not imported.

Local changes add agent-callable operations, prefilled create-and-switch,
return-before-cleanup, optional feature branch deletion, and completion delivery
in the replacement session. The original manager, session transfer, settings,
and Git removal safeguards are retained.

Review upstream changes selectively; do not overwrite local lifecycle behavior
or commit generated upstream runtime files here.
