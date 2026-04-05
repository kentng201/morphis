# Contributing to Morphis

Thank you for your interest in contributing! This document covers everything you need to get started.

---

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Project Structure](#project-structure)
- [Submitting Changes](#submitting-changes)
- [Coding Standards](#coding-standards)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)

---

## Code of Conduct

Be respectful and constructive. Harassment, discrimination, or toxic behaviour of any kind will not be tolerated.

---

## Getting Started

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.0

```bash
# 1. Fork the repo, then clone your fork
git clone https://github.com/kentng201/morphis.git
cd morphis

# 2. Install dependencies
bun install

# 3. Link the CLI locally so you can test it
bun link
```

---

## Development Workflow

```bash
# Run the CLI against a test project
bun run morphis <command>

# Type-check the source
bunx tsc --noEmit

# Pack to verify the published files
npm pack --dry-run
```

All source lives under `src/`. CLI scripts live under `scripts/`.

---

## Project Structure

```
src/
├── http/               # Core HTTP primitives (Router, Middleware, Context, …)
├── middlewares/        # Built-in middleware (Track, Logger, CORS, Validate, …)
└── services/           # Internal services (LoggerService)

scripts/
├── commands/           # CLI command implementations (new, newServer)
├── build.ts            # Build script
├── listRoutes.ts       # route:list implementation
└── index.ts            # CLI entry point
```

---

## Submitting Changes

1. **Open an issue first** for non-trivial changes so we can discuss the approach.
2. Create a branch off `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
3. Make your changes, following the [Coding Standards](#coding-standards) below.
4. Commit with a clear, concise message:
   ```
   feat: add CacheMiddleware with TTL support
   fix: correct param extraction for nested routes
   docs: update README quick-start example
   ```
   We follow [Conventional Commits](https://www.conventionalcommits.org/).
5. Push and open a Pull Request against `main`. Fill in the PR template and link the related issue.

---

## Coding Standards

- **TypeScript strict mode** is enforced — no `any` unless truly unavoidable.
- Keep the HTTP kernel (`src/http/`) framework-agnostic and dependency-free.
- New middleware must extend `Middleware` and expose a named singleton export (see `TrackMiddleware` as a reference).
- New validation rules belong in `src/http/Validator.ts` under `SimpleRules`.
- Do not add runtime dependencies without prior discussion — the framework intentionally has minimal deps.
- Format your code consistently with the existing style (2-space indent, single quotes).

---

## Reporting Bugs

Open a GitHub Issue and include:

- Morphis version (`bun list morphis`)
- Bun version (`bun --version`)
- Minimal reproduction (a few lines of code or a repo link)
- Expected vs actual behaviour

---

## Requesting Features

Open a GitHub Issue with the `enhancement` label. Describe the problem you're solving, not just the solution, so we can discuss the best approach together.

---

## 📄 License

By contributing you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
