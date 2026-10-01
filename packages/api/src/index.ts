// Library surface of the control-plane API (consumed by the web app for the single-project deployment).
export { buildApp, type AppDeps } from "./app.js";
export { createProductionApp, type ProductionApp } from "./production.js";
export { internalSecretFor } from "./auth.js";
