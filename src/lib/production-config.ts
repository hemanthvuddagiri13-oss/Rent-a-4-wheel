import { deploymentEnvironment, localDevelopment, type Environment } from "./deployment-environment";

export type ConfigurationIssue = { field: string; code: "MISSING" | "INVALID" | "UNSAFE" | "PARTIAL" };
export type ConfigurationStatus = { environment: ReturnType<typeof deploymentEnvironment>; ready: boolean; issues: ConfigurationIssue[]; liveFinanceEnabled: false };
const placeholder = /placeholder|changeme|change-me|example|your[-_]|development|ci-only|test-secret/i;
function secret(value: string | undefined, min = 32) { return Boolean(value && value.length >= min && !placeholder.test(value)); }
function url(value: string | undefined) { try { return new URL(value!); } catch { return null; } }

/** Return only fixed field identifiers and reason codes. Never include supplied values. */
export function productionConfiguration(env: Environment = process.env): ConfigurationStatus {
  const environment = deploymentEnvironment(env), issues: ConfigurationIssue[] = [];
  const add = (field: string, code: ConfigurationIssue["code"] = "INVALID") => { if (!issues.some(i => i.field === field && i.code === code)) issues.push({ field, code }); };
  const required = (field: string) => { if (!env[field]) add(field, "MISSING"); };
  const deployed = !localDevelopment(env);
  if (!env.APP_ENV || !["development", "test", "preview", "staging", "production"].includes(env.APP_ENV)) add("APP_ENV", "INVALID");
  if (deployed && ["ALLOW_DEV_PAYMENT_SIMULATION", "ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV", "LOCAL_BUILD_WORKER_THREADS"].some(k => env[k] === "true")) add("DEVELOPMENT_BYPASS", "UNSAFE");
  if (deployed && ["development", "test"].includes(environment)) add("APP_ENV", "UNSAFE");
  for (const field of ["DATABASE_URL", ...(deployed ? ["DIRECT_DATABASE_URL", "SITE_URL", "PRIMARY_DOMAIN", "AUTH_SECRET", "CRON_SECRET", "STRIPE_SECRET_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_CONNECT_COUNTRY", "RESEND_API_KEY", "EMAIL_FROM", "PRIVATE_STORAGE_BUCKET", "PRIVATE_STORAGE_REGION", "PRIVATE_STORAGE_ENDPOINT", "PRIVATE_STORAGE_KMS_KEY_ID", "PRIVATE_STORAGE_ACCESS_KEY_ID", "PRIVATE_STORAGE_SECRET_ACCESS_KEY", "CLAMAV_HOST", "CLAMAV_PORT", "RATE_LIMIT_STORE", "MONITORING_ALERT_URL", "MONITORING_ALERT_SECRET", "DEPLOYMENT_DATA_ENV", "PROVIDER_ACCOUNT_ENV"] : [])]) required(field);
  for (const field of ["DATABASE_URL", "DIRECT_DATABASE_URL"]) {
    const value = env[field]; if (!value) continue; const parsed = url(value);
    if (!parsed || !["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.pathname || parsed.pathname === "/") add(field);
    if (deployed && parsed && ((parsed.searchParams.get("sslmode") !== "require" || parsed.searchParams.get("sslaccept") !== "strict") || placeholder.test(value))) add(field, "UNSAFE");
    if (field === "DIRECT_DATABASE_URL" && parsed && (parsed.searchParams.get("pgbouncer") === "true" || /pooler|pool\./i.test(parsed.hostname))) add(field, "UNSAFE");
  }
  if (deployed) {
    for (const field of ["AUTH_SECRET", "CRON_SECRET", "MONITORING_ALERT_SECRET"]) if (!secret(env[field])) add(field, "UNSAFE");
    if (env.AUTH_SECRET && env.AUTH_SECRET === env.CRON_SECRET) add("CRON_SECRET", "UNSAFE");
    for (const field of ["SITE_URL", "PRIVATE_STORAGE_ENDPOINT", "MONITORING_ALERT_URL"]) {
      const parsed = url(env[field]); if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) add(field, "UNSAFE");
    }
    const site = url(env.SITE_URL);
    if (site?.hostname !== env.PRIMARY_DOMAIN || site?.pathname !== "/") add("PRIMARY_DOMAIN");
    if (environment === "production" && env.PRIMARY_DOMAIN !== "renta4wheel.com") add("PRIMARY_DOMAIN", "UNSAFE");
    if (environment !== "production" && /^(www\.)?(renta4wheel|rentafourwheel)\.com$/.test(env.PRIMARY_DOMAIN ?? "")) add("PRIMARY_DOMAIN", "UNSAFE");
    for (const field of ["NEXTAUTH_URL", "AUTH_URL", "NEXT_PUBLIC_SITE_URL"]) if (env[field] && env[field] !== env.SITE_URL) add(field, "UNSAFE");
    if (env.DEPLOYMENT_DATA_ENV !== environment) add("DEPLOYMENT_DATA_ENV", "UNSAFE");
    if (env.PROVIDER_ACCOUNT_ENV !== environment) add("PROVIDER_ACCOUNT_ENV", "UNSAFE");
    if (env.RATE_LIMIT_STORE !== "postgres") add("RATE_LIMIT_STORE");
    if (!/^[A-Z]{2}$/.test(env.STRIPE_CONNECT_COUNTRY ?? "")) add("STRIPE_CONNECT_COUNTRY");
    if (!/^re_[A-Za-z0-9_]+$/.test(env.RESEND_API_KEY ?? "")) add("RESEND_API_KEY");
    if (!/^[^\r\n]+@[^\s<>]+\.[^\s<>]+>?$/.test(env.EMAIL_FROM ?? "")) add("EMAIL_FROM");
    if (!Number.isInteger(Number(env.CLAMAV_PORT)) || Number(env.CLAMAV_PORT) < 1 || Number(env.CLAMAV_PORT) > 65535) add("CLAMAV_PORT");
    if (env.PRIVATE_STORAGE_PROVIDER !== "s3") add("PRIVATE_STORAGE_PROVIDER", "UNSAFE");
    if (env.PRIVATE_STORAGE_ENV !== environment) add("PRIVATE_STORAGE_ENV", "UNSAFE");
    if (env.VERCEL_ENV === "preview" && environment !== "preview") add("APP_ENV", "UNSAFE");
  }
  const stripe = [env.STRIPE_SECRET_KEY, env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, env.STRIPE_WEBHOOK_SECRET];
  if (stripe.some(Boolean) && !stripe.every(Boolean)) add("STRIPE", "PARTIAL");
  // This phase never enables live money movement, including in production.
  if (env.STRIPE_SECRET_KEY && !/^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY)) add("STRIPE_SECRET_KEY", "UNSAFE");
  if (env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY && !/^pk_test_[A-Za-z0-9]+$/.test(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)) add("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "UNSAFE");
  if (env.STRIPE_WEBHOOK_SECRET && !/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET)) add("STRIPE_WEBHOOK_SECRET");
  if (env.LIVE_FINANCE_ENABLED === "true") add("LIVE_FINANCE_ENABLED", "UNSAFE");
  return { environment, ready: issues.length === 0, issues, liveFinanceEnabled: false };
}
