# Desktop Release Process

SkyeVox Connect desktop releases must be paired across Mac and Windows.

When publishing a new desktop version:

1. Bump the shared version in `package.json`, `package-lock.json`, `electron/package.json`, and `electron/package-lock.json`.
2. Build the Mac DMGs and the Windows installer for the same version number.
3. Publish all desktop artifacts before updating the production version endpoint.
4. Update the download page so Mac Apple Silicon, Mac Intel, and Windows all point to the same release number.
5. Run `npm run check:published-version`. It must verify the live updater endpoint reports the package version for both desktop platforms and that every published installer URL is reachable.

Do not publish a Mac-only or Windows-only desktop release unless explicitly instructed.
