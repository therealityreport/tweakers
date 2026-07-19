# Tweaker Tweak Store

The in-app Tweak Store is configured to read its reviewed registry from this
GitHub Pages URL:

`https://therealityreport.github.io/tweakers/store/index.json`

Released Tweaker builds fetch this URL whenever the store page is opened or
refreshed. The registry can change without a Tweaker app update.

GitHub Pages publishes from the privacy-scrubbed `gh-pages` branch. Editing
`store/index.json` alone does not update the live URL; the synchronized Pages
branch must also be published.

Registry entries must pin installs to `approvedCommitSha`. Tweaker downloads
from GitHub's commit archive URL for that SHA and validates the downloaded
`manifest.json` before replacing an installed tweak.

Publishing flow:

1. User opens Tweaker Settings -> Tweak Store -> Publish Tweak.
2. User enters a GitHub repo.
3. Tweaker resolves the repo's current default-branch commit SHA.
4. Tweaker opens a GitHub issue for admin review with that exact SHA.
5. An admin reviews the repo at that exact commit SHA.
6. The admin confirms the manifest includes an icon URL suitable for the store.
7. The admin adds or updates an `index.json` entry pinned to that SHA.

Admin acceptance:

1. Open the submitted commit URL.
2. Review source and `manifest.json` at that exact commit.
3. Confirm the manifest includes a usable `iconUrl`.
4. Add a `store/index.json` entry with `approvedCommitSha` set to the reviewed
   full SHA.
5. Commit the registry change to `gh-pages`; GitHub Pages publishes it.
