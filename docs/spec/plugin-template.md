# New plugin checklist (staged vNext; not active until harness update)

1. Choose purpose categories independently of extension-point kinds; never request system capabilities just to get a system label. No UI by default for a tool-only plugin.
2. Use existing declared placement: session for chat-task views, project for project views, settings for configuration, sidebar only for global operations. Catalog inside Plugins needs a later real placement/UI implementation; do not pretend it exists or hard-code navigation. Stable tab ids become rights.
3. Include sinty.plugin.json, entry, *.test.ts, CHANGELOG.md. Manifest/package version must match if package.json exists; use node scripts/plugin-version.mjs check/bump. No automatic SDK/core version alignment.
4. Declare narrow permissions and explicit compatibility. Supported comparator examples: core >=0.5.1 <0.6.0; SDK >=0.0.1 <0.1.0. These examples illustrate syntax, not a claim deployed0.5.1 accepts the new metadata; set actual minimum new harness version at release time.
5. Existing plugin.create restrictions and owner apply approval remain. A system category does not permit shell/browser/env/providers/sessions.write. Test network/model effects with synthetic fixtures; no real paid calls in package tests.
6. Package only allowlisted executable/assets/docs, not .env, credentials, personal home/data/workspace or private skills. Prepared artifacts are not published automatically. Signed catalog client/publisher and production trust anchor are pending separate implementation/hosting approval.

Example fields to add to a new package (legacy packages may omit):

```json
{ "categories": ["functional"], "compatibility": { "core": ">=0.6.0 <0.7.0", "sdk": ">=0.0.1 <0.1.0", "protocol": "sinty/1.0" }, "changelog": "CHANGELOG.md" }
```

Do not use the example core version until a matching release has actually shipped. Runtime compatibility failure is not a reason to strip safety metadata.


### Distribution/update metadata
Example additional manifest fields: categories: ["functional"], compatibility: {core: ">=0.5.1 <0.6.0", sdk: ">=0.0.1 <0.1.0"}, changelog: "CHANGELOG.md", updateMode: "restart".
Use rpc-only ONLY for a lifecycle with no untracked background/detached work and no incompatible state migration; both old and new releases must opt in for active hot replacement. Default restart is the safe choice. A UI tab may use placement plugins for Settings > Plugins; a normal path tab stays in the existing sandbox and gains no core catalog/install privileges. Do not copy the reserved plugin-catalog builtin into arbitrary plugins.
Publisher example: node scripts/plugin-publish.mjs --dir BUILT_PLUGIN --out LOCAL_STORE --base https://OWNER_CHOSEN_HOST/plugins/ --key OWNER_SELECTED_KEY_FILE --publisher PUBLISHER_ID --files dist,public,CHANGELOG.md . It only creates local artifacts; deploying them is a separate owner-authorized action. Production keys/anchors must never come from an untrusted feed.
