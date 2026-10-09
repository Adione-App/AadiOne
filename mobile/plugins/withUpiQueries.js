/**
 * Makes UPI apps visible to the app on both platforms.
 *
 * Android 11 (API 30) and iOS 9 both restrict which other apps a package can
 * see, and BOTH FAIL SILENTLY: without the declarations below,
 * `Linking.canOpenURL('phonepe://')` returns false — or throws on iOS — on a
 * phone with PhonePe installed, and a payment checkout (Cashfree's UPI app
 * list included) cannot find the installed UPI apps.
 *
 *   Android  <queries><package> for each app in the catalogue, plus a generic
 *            upi:// intent so the system chooser fallback resolves.
 *   iOS      LSApplicationQueriesSchemes for the same schemes.
 *
 * Both lists are derived from `src/lib/upi-apps.json`, so adding an app there
 * wires up both platforms at once.
 *
 * This lives in a config plugin rather than in android/ and ios/ directly
 * because `expo prebuild` regenerates those folders and would drop the edits.
 */

const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

const upiApps = require('../src/lib/upi-apps.json');

const UPI_SCHEME = 'upi';

const ANDROID_PACKAGES = upiApps.map((app) => app.androidPackage);

// Every scheme the app probes, plus upi:// itself for the chooser fallback.
// Listing schemes we never call would be noise in the App Store review notes.
const IOS_SCHEMES = [UPI_SCHEME, ...upiApps.flatMap((app) => app.schemes)];

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

    // The scheme query above is not enough on its own: probing an app's own
    // scheme (phonepe://) needs that package visible, since phonepe:// is not
    // upi:// and so is not covered by the intent filter.
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
