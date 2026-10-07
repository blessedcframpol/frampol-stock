/**
 * ESM re-export of the shared verify env helper / production guard.
 */
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const helper = require("./verify-env.cjs")

export const PRODUCTION_SUPABASE_REF = helper.PRODUCTION_SUPABASE_REF
export const loadEnvLocal = helper.loadEnvLocal
export const projectRefFromUrl = helper.projectRefFromUrl
export const assertNotProduction = helper.assertNotProduction
export const prepareVerifyEnv = helper.prepareVerifyEnv
