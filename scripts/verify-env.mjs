/**
 * ESM re-export of the shared verify env helper / production guard.
 */
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const helper = require("./verify-env.cjs")

export const PRODUCTION_SUPABASE_REF = helper.PRODUCTION_SUPABASE_REF
export const TEST_SUPABASE_REF_HINT = helper.TEST_SUPABASE_REF_HINT
export const loadEnvLocal = helper.loadEnvLocal
export const loadEnvFile = helper.loadEnvFile
export const loadVerifyEnv = helper.loadVerifyEnv
export const argvHasProductionFlag = helper.argvHasProductionFlag
export const warnIfWorkingHours = helper.warnIfWorkingHours
export const projectRefFromUrl = helper.projectRefFromUrl
export const assertNotProduction = helper.assertNotProduction
export const resolveHarnessDbUrl = helper.resolveHarnessDbUrl
export const prepareVerifyEnv = helper.prepareVerifyEnv
