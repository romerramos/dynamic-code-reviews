# Bundled browser assets

These prebuilt assets are embedded in each generated report. No installer,
package manager, browser compiler or network connection is used during a review.
Keep their licenses with this skill when sharing it.

- daisyUI 5.7.28: https://cdn.jsdelivr.net/npm/daisyui@5.7.28/daisyui.css
  - Upstream documentation: https://daisyui.com/docs/cdn/
  - License: `DAISYUI-LICENSE` (MIT).
  - We use the precompiled component classes. Application layout is ordinary CSS,
    so the Tailwind browser script shown in the CDN quickstart is unnecessary.
- Prism 1.30.0: https://cdn.jsdelivr.net/npm/prismjs@1.30.0/components/
  - Components: core, markup, clike, javascript, css, scss, ruby, sql, json, yaml,
    bash, typescript, jsx, tsx, c, cpp, csharp, java, kotlin, go, rust, python,
    toml, swift, markup-templating, php, markdown, docker, elixir, graphql, lua,
    makefile, ini. The renderer embeds them in dependency order.
  - License: `PRISM-LICENSE` (MIT).
  - No autoloader, worker or network plugins. Unsupported languages remain readable
    plain text; highlighting is presentation, not a parser or correctness check.
- Lucide Static 1.42.0: https://cdn.jsdelivr.net/npm/lucide-static@1.42.0/icons/
  - Documentation: https://lucide.dev/guide/static
  - License: `lucide/LICENSE` (ISC and inherited Feather MIT notices).
  - Only the SVG files used by the review UI are saved in `lucide/`. The Ruby
    renderer embeds them as a lookup table, with no icon font, framework or
    runtime CDN request. Preserve upstream geometry; apply size and stroke in CSS.
- GLightbox 3.3.1: https://github.com/biati-digital/glightbox/tree/v3.3.1
  - Vendored CSS/JS: https://cdn.jsdelivr.net/npm/glightbox@3.3.1/dist/
  - License: `glightbox/LICENSE` (MIT).
  - CSS and JavaScript are embedded inline. The shared viewer opens only embedded image data
    or a rendered code hunk; video remains in its native inline player.
    No CDN, image files, fonts or additional player libraries load at runtime.
- Simple Icons 15.13.0: https://cdn.jsdelivr.net/npm/simple-icons@15.13.0/icons/
  - License: `brands/LICENSE` (CC0 1.0). The marks remain their owners' trademarks; they only say
    which agent wrote a message.
  - Saved in `brands/` under the agent they stand for: `claude.svg` (Claude), `codex.svg` (OpenAI,
    for Codex) and `gemini.svg` (Google Gemini).
- LobeHub Icons 1.95.1 (`@lobehub/icons-static-svg`): https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.95.1/icons/
  - License: `brands/LOBEHUB-LICENSE` (MIT). The marks remain their owners' trademarks.
  - `grok.svg` (Grok, from `grok.svg`), `opencode.svg` (opencode, from `opencode.svg`) and
    `antigravity.svg` (Google Antigravity, from
    `antigravity-color.svg`). Simple Icons has neither. Any other agent shows its initial.

Update only when needed, pin versions, retain license text, and verify the
synthetic diff fixture plus actual token colors/layout after a library change.
The full daisyUI stylesheet is vendored to avoid a build pipeline. A page carries only its rules
for classes the app's own files name (`lib/dcr/stylesheet.rb`): the whole of it made a long file
slow to open.
- JetBrains Mono (variable) 5.2.8, from Fontsource: https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.2.8/files/
  - Files: the Latin and Latin Extended upright and the Latin italic variable fonts, in `fonts/jetbrains-mono/`.
  - License: `fonts/jetbrains-mono/LICENSE` (SIL Open Font License 1.1).
  - Used by the Terminal theme, which names them with `url(vendor/fonts/...)`; the renderer embeds
    them in the page as data, so no font is fetched at runtime.
- GitHub mark: the `mark-github` icon of Primer Octicons (https://github.com/primer/octicons, MIT),
  inlined in `assets/report.js` as `ghMark`. It marks the one button that sends a comment to GitHub.
