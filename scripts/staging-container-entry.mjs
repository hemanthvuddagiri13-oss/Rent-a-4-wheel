// No automatic migrations, seed, approval or provider operations at startup.
if (process.env.APP_ENV !== 'staging' || process.env.LIVE_FINANCE_ENABLED !== 'false' || process.env.ALLOW_DEV_PAYMENT_SIMULATION !== 'false' || process.env.ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV === 'true') {
  console.error('STAGING_CONTAINER_CONFIGURATION_REFUSED'); process.exit(1);
}
await import('./server.js');
