/**
 * Type declarations for scripts/db-ensure.mjs, which is plain ESM so it can run
 * directly with `node scripts/db-ensure.mjs` (no build step) while also being
 * imported by the admin schema-sync module (src/lib/admin/schema-sync.ts).
 */

export type SchemaStep = { name: string; sql: string };

export declare const STEPS: SchemaStep[];
