# Contributing

FlowProof is intentionally evidence-first. A check may return `PASS` only when its required evidence is present and deterministic. Missing or ambiguous evidence must return `UNKNOWN`.

## Development

Use Node.js 24 for parity with CI. The project has no runtime dependencies.

```bash
npm ci
npm run check
```

Changes should include tests for passing, failing, and missing-evidence cases where applicable. Keep database access read-only, avoid collecting raw rows, and never include credentials or customer identifiers in fixtures.

## Pull requests

Keep pull requests focused. Explain the incident being prevented, the evidence used, and the exact conditions producing each status. Interface changes must update the README and examples.
