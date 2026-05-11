# spark-dashboard — Claude project rules

Project-specific. Global rules in `~/.claude/rules/` still apply.

## Branches & PRs

- This fork (`HarrisonW/spark-dashboard`) permits direct pushes to `main`
  by the maintainer — Claude may commit and push without opening a PR
  when working solo. PRs are still the right tool for collaborative
  changes and for contributing back to upstream (`niklasfrick/spark-dashboard`).
- Branch name (when a PR is used): `<type>/<slug>`
  (`feat/...`, `fix/...`, `docs/...`).
- Each commit landing on `main` (direct or via squash-merge) must be a
  valid Conventional Commit — `release-please` reads them to decide
  version bumps.
- `ci.yml` (rust, frontend, installer) should still be green before a
  release tag goes out.

## Commits drive releases

`release-please` reads commits on `main` to bump versions and publish to crates.io. Format: `<type>(<scope>)<!>: <description>`.

| Type                                                       | Bump (pre-1.0)                  |
| ---------------------------------------------------------- | ------------------------------- |
| `feat:`                                                    | minor                           |
| `fix:`                                                     | patch                           |
| `feat!:` / `BREAKING CHANGE:`                              | minor (becomes major after 1.0) |
| `chore`, `docs`, `refactor`, `test`, `ci`, `perf`, `style` | none                            |

Tags: `vX.Y.Z`. After merge, release-please opens a rolling release PR; merging it tags + triggers `publish.yml` (`cargo publish`).

**Never hand-edit**: `Cargo.toml` version, `Cargo.lock`, `.release-please-manifest.json`, `frontend/package.json`, `frontend/package-lock.json`, `CHANGELOG.md`. Release-please owns them.

## Pre-commit checks (run before pushing)

Rust changes (`src/`, `Cargo.*`):

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

Frontend changes (`frontend/`):

```bash
cd frontend && npm run build && npm test -- --run
```

If both stacks changed, run both blocks. If embedded assets changed, build the frontend first (`rust-embed` needs `frontend/dist/`).

## Metrics contract (Rust ↔ frontend)

When you change `MemoryMetrics`/`GpuMetrics`/`CpuMetrics` shape, serde names, display logic, or fields — update all of these in the same PR:

1. Rust unit tests in `src/metrics/`
2. TS types in `frontend/src/types/metrics.ts`
3. Formatters in `frontend/src/lib/format.ts`
4. Vitest specs in `frontend/src/__tests__/`
5. Components in `frontend/src/components/`

If one is genuinely N/A, say so in the commit.

## Tests ship with the change

No behavior change merges without test coverage in the same PR. Rust branches → `#[cfg(test)]`. Frontend components/formatters → Vitest. New API field → both sides.
