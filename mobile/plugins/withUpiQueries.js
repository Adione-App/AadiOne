/**
 * Makes UPI apps visible to the app on both platforms.
 *
 * Android 11 (API 30) and iOS 9 both restrict which other apps a package can
 * see, and BOTH FAIL SILENTLY: without the declarations below, Cashfree's
 * checkout cannot find or open the UPI apps installed on the phone (its UPI
 * app list stays empty), even though the apps are there.
 *
 *   Android  <queries><package> for each common UPI app, plus a generic
 *            upi:// intent so any UPI app (and the system chooser) resolves.
 *   iOS      LSApplicationQueriesSchemes for the same apps' schemes.
 *
 * The lists are kept here (they used to be derived from the app's own UPI
 * app-picker catalogue, removed with that screen — Cashfree's checkout now
 * lists the apps itself). Same values, same order: the generated manifest and
 * Info.plist are unchanged.
 *
 * This lives in a config plugin rather than in android/ and ios/ directly
 * because `expo prebuild` regenerates those folders and would drop the edits.
 */

const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

const UPI_SCHEME = 'upi';

// Google Pay, PhonePe, Paytm, BHIM.
const ANDROID_PACKAGES = [
  'com.google.android.apps.nbu.paisa.user',
  'com.phonepe.app',
  'net.one97.paytm',
  'in.org.npci.upiapp',
];

// upi:// itself for the chooser fallback, then each app's own schemes.
const IOS_SCHEMES = [UPI_SCHEME, 'tez', 'gpay', 'phonepe', 'paytmmp', 'paytm', 'bhim'];

function withUpiAndroidQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const { manifest } = cfg.modResults;

    manifest.queries = manifest.queries ?? [];
    if (manifest.queries.length === 0) manifest.queries.push({});

    const queries = manifest.queries[0];
    queries.intent = queries.intent ?? [];
    queries.package = queries.package ?? [];

    const schemeDeclared = queries.intent.some((intent) =>
      (intent.data ?? []).some((d) => d.$?.['android:scheme'] === UPI_SCHEME),
    );

    if (!schemeDeclared) {
      // No <category> here on purpose: package-visibility matching follows the
      // usual intent-filter rules, so naming a category the target app happens
      // not to declare would narrow the match and hide it again.
      queries.intent.push({
        action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
        data: [{ $: { 'android:scheme': UPI_SCHEME } }],
      });
    }

    // The scheme query above is not enough on its own: opening an app by its
    // own scheme (phonepe://) needs that package visible, since phonepe:// is
    // not upi:// and so is not covered by the intent filter.
    for (const pkg of ANDROID_PACKAGES) {
      const already = queries.package.some((p) => p.$?.['android:name'] === pkg);
      if (!already) queries.package.push({ $: { 'android:name': pkg } });
    }

    return cfg;
  });
}

function withUpiIosQueries(config) {
  return withInfoPlist(config, (cfg) => {
    const existing = cfg.modResults.LSApplicationQueriesSchemes ?? [];
    // A Set keeps this idempotent across prebuilds and preserves anything
    // another plugin already added.
    cfg.modResults.LSApplicationQueriesSchemes = [...new Set([...existing, ...IOS_SCHEMES])];
    return cfg;
  });
}

module.exports = function withUpiQueries(config) {
  return withUpiIosQueries(withUpiAndroidQueries(config));
};

// For the config check (tests/upiQueriesPlugin.test.ts).
module.exports.ANDROID_PACKAGES = ANDROID_PACKAGES;
module.exports.IOS_SCHEMES = IOS_SCHEMES;
