/**
 * The AdiOne shared contract.
 *
 * This folder is the SINGLE SOURCE OF TRUTH for everything the backend, the
 * web admin panel and the mobile app must agree on: domain enums, the order
 * state machine, error codes, the wire format, DTOs, business helpers and the
 * design tokens.
 *
 * The three projects are independent (separate folders, separate installs, no
 * workspace linking), so this folder is mirrored into them:
 *
 *     backend/src/shared/     <- canonical, edit here
 *     web/src/shared/         <- generated copy, do not edit
 *     mobile/src/shared/      <- generated copy, do not edit
 *
 * Run `npm run sync:shared` in `backend/` after changing anything here. The
 * copies are marked read-only-by-convention with a banner comment; editing a
 * copy will be overwritten on the next sync.
 *
 * Everything here must stay dependency-free and platform-neutral: no Node
 * built-ins, no Prisma, no Express, no React. It has to run in Node, in a
 * browser and in Hermes.
 */

/* domain contract */
export * from './enums';
export * from './order-state-machine';
export * from './errors';
export * from './api';
export * from './permissions';
export * from './config-keys';
export * from './dto';

/* business helpers (pure functions) */
export * from './money';
export * from './distance';
export * from './phone';
export * from './datetime';
export * from './cod';
export * from './text';

/* design tokens */
export * from './theme';
