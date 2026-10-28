DeepSeek whale SVG: unmodified favicon.svg from @deepseek-ai/dsh-web-frontend 0.1.5-rc.2. Sidebar, workspace, conversation and composer layout reference: installed DeepSeek Harness client UI packages 0.1.5-rc.2, MIT license included. This is a local team extension with its own authenticated backend, not the unmodified official frontend distribution.

Chat input geometry and interaction reference: @deepseek-ai/dsh-client-ui-conversation 0.1.5-rc.2 (InputBar, ConversationRoot, keyboard/queue contract), installed official MIT distribution. React rendering, authenticated model catalog, project permission controls and queue adapter are maintained by this team extension. This companion chat does not load arbitrary upstream plugins or expose the host filesystem.

Native workbench: unmodified official DeepSeek Harness Web modules 0.1.5-rc.2, launched by @deepseek-ai/dsh 0.1.5-rc.1 in per-account Linux containers. The full official dependency inventory is pinned in native-harness/package-lock.json; upstream MIT notices remain in the image. The team extension adds authentication, a model gateway, capability policy, account/project isolation, and reviewed project publication. Native plugins and shell commands execute inside the account container, not directly on the macOS host.

## Magpie

Magpie model gateway source: https://github.com/yetone/magpie
Pinned upstream commit: ba319a7587923fc7a4ea3859658244d591261a59
Copyright (c) 2026 yetone. MIT License; full text in vendor/magpie/LICENSE.
Local integration code is tracked separately from the upstream source manifest.
