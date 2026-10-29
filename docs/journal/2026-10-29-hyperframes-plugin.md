# Agents can render HyperFrames

HyperFrames is an HTML-to-MP4 tool. The harness had no way to call it, and no place that said when the upstream project moved.

## What changed

Plugin `hyperframes`. `hyperframes.write` stores `index.html` in the workspace. `hyperframes.render` runs `npx hyperframes render` for at most three minutes. The sidebar tab asks npm and GitHub. The first answer is stored. A later difference lights the indicator. Marking it seen stores the new version and commit.

## Why

Agents should make a video from HTML without a separate worker, and a person should see when HyperFrames itself has an update.
