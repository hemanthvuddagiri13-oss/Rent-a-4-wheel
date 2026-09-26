import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// These are public bundle inputs, never provider secrets. Next.js freezes them
// at build time; runtime-only environment injection cannot replace them.
export function stagingPublicConfig(env) {
  const site = new URL(env.NEXT_PUBLIC_SITE_URL ?? '');
  if (site.protocol !== 'https:' || site.origin !== env.NEXT_PUBLIC_SITE_URL || site.port || !/^staging\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(site.hostname) || /\.(localhost|local|internal|invalid|test|example)$/.test(site.hostname)) throw new Error('STAGING_PUBLIC_ORIGIN_REFUSED');
  const publishableKey = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
  if (publishableKey && !/^pk_test_[A-Za-z0-9]+$/.test(publishableKey)) throw new Error('STAGING_PUBLIC_KEY_REFUSED');
  return { siteUrl: site.origin, publishableKey };
}

export function assertStagingPublicRuntime(env, built) {
  // An unconfigured image may expose liveness, but readiness remains false.
  // Once supplied, deployment values must match the immutable client bundle.
  if ((env.SITE_URL && env.SITE_URL !== built.siteUrl) || (env.NEXT_PUBLIC_SITE_URL && env.NEXT_PUBLIC_SITE_URL !== built.siteUrl) || (env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '') !== built.publishableKey) throw new Error('STAGING_PUBLIC_BUILD_RUNTIME_MISMATCH');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync('staging-public-config.json', JSON.stringify(stagingPublicConfig(process.env)));
}
