# @atlas/ui 1.0.0

Reference: Atlas CRM (`73bf0f0`), official corporate palette and Outfit typography.
CRM and Analytics are not modified by this release. Small text and action colors use
accessible darker shades of the corporate blue instead of white over #049dd9.

Canonical implementation: Atlas Lead `packages/atlas-ui`. Data consumes the exact
version under `vendor/atlas-ui`. This avoids a private registry and React/Tailwind
upgrades: plain CSS plus React 18/19 components. Do not edit the vendor copy.

To update: bump this version, run `node scripts/sync-atlas-ui.mjs /path/to/mdata`,
then `node scripts/sync-atlas-ui.mjs /path/to/mdata --check`. Commit both products,
build and validate before independently deploying either. No runtime dependency
on the other app. The package can later be published without changing its API.

Adapters own product class names, routes, authentication, permissions and data.
Typography is supplied via Next's Outfit font variable (`--font-outfit`).
Theme preference is local to each origin, not shared authentication or SSO.
The shared responsive shell preserves product navigation and native link behavior;
mobile navigation is an expandable region (not a modal), closed by Escape or link.

Verify dashboard, list/filter, detail/form and login in light/dark at desktop/mobile.
Check text contrast, overflow, focus visibility, active navigation and persistence.
Never run campaign sends, data imports or writes as part of visual verification.
