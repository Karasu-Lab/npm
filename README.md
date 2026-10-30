# npm

Publishes the Karasu Lab workspace packages to GitHub Packages.

The `packages/` directory holds every package repository as a git
submodule. The **Publish packages** workflow updates each submodule to
the tip of its `main` branch, scans the packages, and publishes every
package whose current state is not on the registry yet:

- A package is publishable when its `package.json` is not `private`.
- The published version is the package's own version suffixed with the
  short hash of the scanned commit (for example `0.1.0-0123abc`), so a
  version identifies exactly one source state and never changes after
  publishing.
- Packages are published in dependency order with workspace
  dependencies rewritten to the exact published versions.

Consumers pin the exact version they want, which keeps every install
reproducible. Installing requires a token with `read:packages`, even
for public packages — that is a GitHub Packages rule:

```ini
@karasu-lab:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Applications that live in the pnpm workspace resolve these packages
from the workspace sources instead, through `pnpm.overrides` entries
that map each package to `workspace:*`; both routes resolve the same
commit, so local development and registry installs cannot drift apart.
