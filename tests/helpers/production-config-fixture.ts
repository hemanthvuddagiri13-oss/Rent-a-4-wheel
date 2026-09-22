// Synthetic syntax fixture only. No provider or professional approval is implied.
export const configured = () => ({
  APP_ENV: "staging", NODE_ENV: "production", DATABASE_URL: "postgresql://runtime:secure@db.internal/staging?sslmode=require&sslaccept=strict",
  DIRECT_DATABASE_URL: "postgresql://migration:secure@db.internal/staging?sslmode=require&sslaccept=strict", SITE_URL: "https://staging.renta4wheel.com",
  PRIMARY_DOMAIN: "staging.renta4wheel.com", AUTH_SECRET: "a".repeat(48), CRON_SECRET: "b".repeat(48),
  STRIPE_SECRET_KEY: "sk_test_fixture", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  STRIPE_CONNECT_COUNTRY: "US", RESEND_API_KEY: "re_fixture", EMAIL_FROM: "Staging <staging@renta4wheel.com>",
  PRIVATE_STORAGE_PROVIDER: "s3", PRIVATE_STORAGE_ENV: "staging", PRIVATE_STORAGE_BUCKET: "r4w-staging-private",
  PRIVATE_STORAGE_REGION: "us-east-1", PRIVATE_STORAGE_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
  PRIVATE_STORAGE_KMS_KEY_ID: "staging-key", PRIVATE_STORAGE_ACCESS_KEY_ID: "fixture", PRIVATE_STORAGE_SECRET_ACCESS_KEY: "fixture",
  CLAMAV_HOST: "scanner.internal", CLAMAV_PORT: "3310", CLAMAV_TLS: "true", RATE_LIMIT_STORE: "postgres",
  MONITORING_ALERT_URL: "https://alerts.internal/ingest", MONITORING_ALERT_SECRET: "c".repeat(48), DEPLOYMENT_DATA_ENV: "staging", PROVIDER_ACCOUNT_ENV: "staging",
});
