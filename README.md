# 🚀 Morphis

**The Laravel-Inspired Backend Framework for Bun**

Morphis is a modern, opinionated web framework for developers who love the elegant patterns of Laravel but crave the raw speed of the Bun runtime. It brings a full-stack, batteries-included architecture to the TypeScript ecosystem — structured enough to eliminate decision fatigue, flexible enough to scale from a monolith to microservices.

---

## ✨ Core Philosophy

Most Node.js frameworks are unopinionated, leading to "architecture fatigue." Morphis solves that by providing a rigid, stable, and highly productive structure:

- **Performance First** — Built directly on Bun's native HTTP server for maximum throughput with minimal overhead.
- **Modular by Design** — Native multi-server support via per-file `.env` configurations, making microservice splits painless.
- **Developer Joy** — Strong TypeScript typing, clean abstractions, and zero-config scaffolding so you can focus on business logic.

---

## 🛠 Features

- ⚡ **High-Speed Routing** — Expressive `router.get/post/put/delete/patch()` API with named parameters (`:id`) and resource-style controllers, powered by Bun's native HTTP server.
- 🏢 **Controller Architecture** — Class-based controllers with the `@Controller` decorator cleanly separate request handling from business logic.
- 🛡 **Declarative Validation** — Rich built-in rule set (`Required`, `Email`, `Min`, `Max`, `Regex`, `Enum`, `Between`, …) via `Validate` — no third-party validator needed.
- 🔄 **Transformers** — A dedicated `Transformer` base class formats API responses and decouples your internal models from public contracts.
- 🚦 **Flexible Middleware** — A composable `Middleware` base class lets you hook into the request/response lifecycle for auth, logging, CORS, and more. Apply globally with `router.use()`, per-route, per-method, or as a class decorator.
- 🌐 **Built-in CORS** — Configurable `CorsMiddleware` with per-origin allow-lists and preflight support.
- 📋 **Request Tracking** — `Track` middleware stamps every request with a unique `X-Track-Id` header and makes it available on `current.trackId` throughout the request lifecycle.
- 🔍 **Structured Logging** — `Logger` middleware records method, path, status, and latency for every request.
- 🧩 **Typed Request Context** — `AsyncLocalStorage`-backed `current` proxy provides safe, ergonomic access to per-request state. Extend it with a single `declare module 'morphis'` block — no subclass required.
- 🏗 **CLI Scaffolding** — `morphis new`, `morphis dev`, `morphis build`, `morphis start`, and `morphis route:list` to scaffold, develop, and ship without boilerplate.

---

## 📂 Project Structure

```
src/
├── controllers/        # Request handling — thin, focused, decorator-driven
├── middlewares/        # Custom middleware (auth, rate-limit, etc.)
├── providers/          # Bootstrap & service registration
├── routes/             # One file per server entry-point (api.ts, admin.ts, …)
├── services/           # Business logic core — framework-agnostic
├── transformers/       # Response shaping & field masking
├── types/
│   └── Context.d.ts    # Extend the request context with your own fields
├── validations/        # Reusable validation rule sets
└── index.ts            # Entry point — picks the server from --server=<name>
```

Each `.env.<name>` file defines an independent server. `morphis dev --server=api` boots `.env.api`, meaning you can run `api`, `admin`, or `worker` as separate processes from the same codebase — no refactoring required.

---

## 🚀 Quick Start

**Install the CLI globally:**

```bash
bun install -g morphis
```

**Create a new project:**

```bash
morphis new my-api
cd my-api
bun install
```

**Start the dev server:**

```bash
bun run dev          # runs morphis dev --server=api
```

**List all registered routes:**

```bash
bun run route:list
```

---

## ✍️ Basic Usage

```ts
// src/routes/api.ts
import { Get, Post, Router, Validate, Track, Logger } from 'morphis';
import { SimpleRules as R } from 'morphis';

const router = new Router();

// Simple GET
router.get(() => ({ message: 'OK' }), [Get('/')]);

// POST with validation
router.post((req) => {
    const { name, email } = req.body as any;
    return { created: { name, email } };
}, [
    Post('/users'),
    Validate({ name: [R.Required], email: [R.Required, R.Email] }),
]);

// Global middleware
router.use([Track, Logger]);

export default router;
```

**Extend the request context with your own fields — no subclass needed:**

```ts
// src/types/Context.d.ts
export { };

declare module 'morphis' {
    interface Context {
        userId?: number;
        tenantId?: string;
    }
}
```

```ts
import { current } from 'morphis';

current.userId = 42;  // fully typed
```

---

## ⚖️ Stability & Architecture

Unlike boilerplates that eject the framework into your project, Morphis keeps its HTTP kernel as a protected, versioned core. You write business logic in Services and Controllers; the underlying engine stays stable, secure, and updatable via a simple `bun update morphis`.

---

## 📄 License

MIT © [Kent Ng](mailto:kent.ng201@gmail.com)
