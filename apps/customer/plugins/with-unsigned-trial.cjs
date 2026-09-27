// Expo loads local config plugins synchronously as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withAppBuildGradle } = require('expo/config-plugins');
// Expo's release template otherwise uses its public debug key. Device trial
// output must remain unsigned until the operator supplies a private key.
module.exports = config => withAppBuildGradle(config, result => {
  const source = result.modResults.contents;
  // Expo may run this mod again on an already generated native project. Accept
  // only its known debug template or our exact unsigned output, not another key.
  const pattern = /(release\s*\{\s*(?:\/\/[^\n]*\n\s*)*)signingConfig (?:signingConfigs\.debug|null)(?=\s*(?:\r?\n|\}))/;
  if (!pattern.test(source)) throw new Error('Unknown Android release signing template; refusing trial build');
  result.modResults.contents = source.replace(pattern, '$1signingConfig null');
  return result;
});
