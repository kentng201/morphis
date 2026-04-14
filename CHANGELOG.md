# CHANGELOG

Generated from git tags, commit history, and code-level diffs in this repository.

## v0.6.1: D1 Support, Cloudflare Deployment, CORS Reliability, and Model Mapping Fixes
- Added Cloudflare D1 support across migration, connection resolution, database typing, model introspection, and deploy-time binding generation so D1-backed projects can use the full Drizzle-based workflow locally and on Cloudflare.
- Added Cloudflare D1-specific scaffolding to project creation and connection setup so new D1 projects can capture the remote database name and UUID and write the needed environment variables automatically.
- Improved CLI migration and deploy flows to resolve the active connection more reliably for D1 and other SQL drivers, including fail-fast deploy-time migration execution that aborts release on migration errors.
- Preserved the local SQLite fallback path for Bun development while keeping the same D1-oriented connection config compatible with remote Cloudflare Workers.
- Fixed router and CORS middleware interaction so CORS headers are preserved for preflight, normal, and error responses even when CORS is not the first middleware.
- Improved model field normalization to map camelCase and snake_case names automatically during query and persistence operations, while returning cleaner camelCase output.
- Added a regression test covering CORS middleware ordering behavior.

## v0.6.0: Drizzle ORM and Runtime Infrastructure Release
- Added centralized framework error primitives and router-level error serialization so controllers, middlewares, and services can throw typed errors with status codes, headers, and custom response bodies.
- Expanded first-class HTTP errors to cover the full standard 4xx/5xx status-code set, and added helpers to map status codes into default messages and framework error instances.
- Changed validation and connection middleware to throw typed errors instead of returning ad-hoc JSON responses, and updated Track middleware to log and rethrow so the router is the single HTTP error formatter.


## v0.5.0: Drizzle ORM and Runtime Infrastructure Release
- Replaced the Sequelize-based database stack with Drizzle ORM across `src/db`, `src/models`, and connection middleware.
- Changed `current.db` from a single loose database handle into a keyed connection map that is populated only for connections attached by `Connect()`.
- Added typed connection generation based on driver selection so scaffolded projects get stronger database context types.
- Added `morphis new:env` and shared env-target resolution for `dev`, `build`, `start`, `docker:build`, and `deploy` commands.
- Added `morphis new:service` to scaffold service classes with a default instance export.
- Added request tracing support through `src/http/Trace.ts` and router/context trace stack handling.
- Improved `new:model`, `sync:model`, and `migrate` flows to align with live database structure and the Drizzle-oriented model layer.
- Improved logger behavior to bind directly to console output, replace route params with real values, and surface better caller context.
- Fixed model compatibility edge cases for legacy Sequelize-style usage during the migration period.

## v0.4.1: Cloudflare Serverless Deployment Support
- Added Cloudflare deployment support in `scripts/commands/deploy.ts`.
- Updated Docker build and deployment flow to handle the Cloudflare target alongside the existing serverless pipeline.
- Finalized the first full multi-target serverless deployment set across AWS, Google Cloud, and Cloudflare.

## v0.4.0: Serverless Build and Deployment Expansion
- Added `morphis docker:build` to package servers for deployment.
- Added the initial `morphis deploy` command for AWS and Google Cloud serverless workflows.
- Extended CLI command registration and help output to expose the new deployment pipeline.
- Fixed CORS middleware so allowed methods and headers can be configured as string arrays.

## v0.3.0: Database Config Map and Model Sync
- Changed database configuration from an array structure to a key-value map.
- Added `morphis sync:model` to sync model field declarations from live database columns.
- Added automatic `git init` during new project creation.
- Fixed connection typing and default connection resolution.
- Fixed model timestamp defaults and related model-generation edge cases.

## v0.2.0: Scaffolding, Database, and Multi-thread Foundations
- Added `morphis new:connection` for adding database connections to an existing project.
- Added `morphis new:model`, `morphis new:controller`, `morphis new:validator`, and `morphis new:migration` scaffolding commands.
- Added `morphis migrate` for running database migrations.
- Added `morphis kill:thread` for stopping project-specific processes bound to a server port.
- Reorganized CLI scripts into `scripts/commands` and expanded `scripts/index.ts` dispatching.
- Added `src/db/ConnectionManager.ts`, `src/middlewares/ConnectionMiddleware.ts`, and `src/middlewares/ConnectMiddleware.ts` as the first database connection layer.
- Added `src/models/Model.ts` and `src/types/Database.ts` as the first model and database type foundations.
- Added CLI prompt and project-spawn utilities to support interactive scaffolding and project-aware command execution.
- Added multi-thread runtime support and env-driven server configuration.
- Fixed build/start command flow, validator exports, connection manager issues, migration folder handling, and Track middleware error display.

## v0.1.0: Initial Bun HTTP Server and Project Tooling
- Added the default Bun HTTP server structure.
- Added the first Morphis project-management script flow.
- Established the initial framework and CLI baseline for later scaffolding and runtime features.