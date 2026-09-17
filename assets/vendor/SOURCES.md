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
  - Components: core, markup, clike, javascript, css, ruby, sql, json, yaml, bash,
    typescript. The renderer embeds them in dependency order.
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

Update only when needed, pin versions, retain license text, and verify the
synthetic diff fixture plus actual token colors/layout after a library change.
The full daisyUI stylesheet is bundled intentionally to avoid a build pipeline.
