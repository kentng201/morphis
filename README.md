<h1 align="center">Morphis</h1>

<p align="center">Opinionated HTTP framework for Bun with a Laravel-shaped structure for TypeScript backend teams.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/morphis"><img src="https://img.shields.io/npm/v/morphis" alt="Latest Stable Version"></a>
  <a href="https://www.npmjs.com/package/morphis"><img src="https://img.shields.io/npm/dm/morphis" alt="Total Downloads"></a>
  <a href="https://morphis.pages.dev"><img src="https://img.shields.io/badge/docs-morphis.pages.dev-bb7a3c" alt="Documentation"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/morphis" alt="License"></a>
</p>

## About Morphis

Morphis is a web application framework for Bun with expressive, predictable structure. It is built for backend teams that like the flow of Laravel but want a Bun-first runtime, TypeScript ergonomics, and a source tree that stays easy to reason about as services grow.

Morphis takes the repetitive setup work out of backend development by providing:

- Bun-first execution with a fast HTTP and routing layer
- Laravel-shaped project structure with controllers, services, validators, transformers, and middleware
- Built-in request validation with expressive rules such as `Required`, `Email`, `Min`, `Max`, `Enum`, and `Between`
- Typed request context backed by `AsyncLocalStorage`
- Middleware-driven request handling for CORS, logging, tracking, transformation, and database connection resolution
- CLI scaffolding for new apps, servers, models, controllers, services, validators, migrations, and environment files
- OpenAPI and JSON route output for inspection, testing, and documentation workflows
- Drizzle-based model, connection, and transaction tooling for structured database access

Morphis is accessible, fast, and structured for teams that want to ship robust APIs without rebuilding the same application skeleton on every project.

## Learning Morphis

Morphis documentation lives at [morphis.pages.dev](https://morphis.pages.dev), which serves as both the landing page and the main documentation hub.

Start with these pages:

- [Landing Page](https://morphis.pages.dev)
- [Getting Started](https://morphis.pages.dev/docs/getting-started)
- [Core Concepts](https://morphis.pages.dev/docs/core-concepts)
- [CLI](https://morphis.pages.dev/docs/cli)
- [Middleware](https://morphis.pages.dev/docs/http/middleware)
- [Database Overview](https://morphis.pages.dev/docs/database/overview)
- [API Reference](https://morphis.pages.dev/docs/api-reference)
- [Deployment](https://morphis.pages.dev/docs/deployment)

If you want the shortest path to a running Morphis backend:

```bash
bun i morphis -g
morphis new my-backend
cd my-backend
bun install
bun dev
```

## Contributing

Thank you for considering contributing to Morphis. The contribution guide can be found in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Code of Conduct

In order to ensure that the Morphis community is welcoming to all, please review and follow the [Code of Conduct](./CONTRIBUTING.md#code-of-conduct).

## Security Vulnerabilities

If you discover a security vulnerability within Morphis, please send an e-mail to Kent Ng via [kent.ng201@gmail.com](mailto:kent.ng201@gmail.com). Security reports will be handled privately.

## License

Morphis is open-source software licensed under the [MIT license](./LICENSE).
