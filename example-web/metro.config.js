const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Disable Watchman so Metro uses the Node.js filesystem crawler.
// This project lives inside a parent git repo whose .gitignore includes
// `node_modules/`, which causes Watchman to skip node_modules entirely.
// The Node.js crawler ignores .gitignore rules and finds all files correctly.
config.resolver.useWatchman = false;

module.exports = config;
