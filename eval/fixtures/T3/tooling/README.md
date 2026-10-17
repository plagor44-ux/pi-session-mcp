# T3 UI fixture browser tooling

This package pins only local development tooling for the synthetic React/Vite fixture. Install it with `npm ci` from this directory. The oracle reads these modules by path and aliases React from this tooling directory into the copied public workspace. Vite's built-in esbuild JSX transform handles the fixture; no React plugin is required.

Playwright requires a compatible Chromium browser installation. It tries Playwright's installed Chromium channel; set `PI_PROFILE_EVAL_CHROMIUM_EXECUTABLE` to an explicitly provisioned executable when the environment uses a different browser path. If no browser is available, the oracle returns `BLOCKED` and does not claim a UI pass.

The pinned Playwright version was taken from the already available `playwright-cli` package metadata; this fixture does not install or update a global package.
