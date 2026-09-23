/* eslint-disable @typescript-eslint/no-require-imports -- Metro loads this configuration as CommonJS. */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../../packages/mobile-client')];
module.exports = config;
