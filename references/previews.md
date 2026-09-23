# Template previews

Show reviewers what changed templates look like: every changed Rails partial and
ViewComponent template gets static HTML rendered by the reviewed app itself, with
example data, shown beside the code. Other stacks show no preview.

## When

After publishing the review, when the scope changes `.html.erb` partials or
ViewComponent templates/classes and the app's development environment is running
(the same environment question as visual QA; reuse the answer). Cover every changed
visual template. Mark a template `not_visual` when it only renders Turbo streams,
JSON, email headers or similar; the report then shows no pane for it. A failing
example becomes `unavailable` with its error and never blocks the review.
`series.rb previews` refuses a set that leaves any changed `.html.erb` file or
`app/components/**/*_component.rb` unaccounted for, or a `not_visual` entry without a
reason; the report shows that reason in place of a preview.

## Author a spec

Write `spec.json` in the scratch directory, never in the reviewed project:

```json
{
  "controller": "BackOffice::InboxController",
  "host": "app.example.test",
  "body_class": "nav-v2",
  "setup": "operator = Operator.find_by!(name: \"Demo\")\nCurrent.operator = operator\nassign(\"operator\" => operator)",
  "previews": [
    {"id": "row-current", "files": ["app/components/row_component.html.erb", "app/components/row_component.rb"],
     "title": "Row with the current item", "source": "example", "note": "Seed data; second item current.",
     "width": 280, "wrap": "<ul class=\"menu\">%s</ul>",
     "ruby": "render RowComponent.new(item: Item.new(label: \"Inbox\", active: true))"},
    {"id": "streams", "files": ["app/views/inbox/_streams.html.erb"], "status": "not_visual",
     "note": "Renders only Turbo stream actions."}
  ]
}
```

- `setup` and `ruby` run in a view context of `controller` (fresh per example) with
  a test request for `host`. Use `assign(...)` for view instance variables,
  `controller.instance_variable_set` for controller state, and set `Current`
  attributes the templates read. Each example runs in a savepoint that is always
  rolled back, so factories and `create` are safe; nothing persists.
- Choose realistic data from the component's parameters, its tests, factories and
  seeds. Prefer existing records for lists (read-only in practice). Add a second
  example for each state or variant the change affects (current vs. not current,
  empty, desktop vs. mobile). Do not prune variants by eye: examples whose markup
  differs only in ids, data or ARIA attributes are merged when rendering, and the
  report folds examples of one template that look the same once they are displayed
  (same visible text, icons, images and height; hidden markup ignored).
- **Reuse Lookbook/ViewComponent previews** when one exists for the component
  (for example under `test/components/previews`), with `"source": "lookbook"`:
  `result = FooComponentPreview.new.default; render(result[:component], &result[:block])`,
  or `render(template: result[:template], locals: result[:locals])` for preview templates.
- `wrap` places the output inside the markup its CSS expects (a list, a sidebar, an
  open flyout). Add `style="height:…;display:grid"` to the outer wrapper when the
  component fills a fixed-height column in the app (absolute empty states, split
  panes). `body_class` repeats classes the layout puts on `<body>`.
- `width` is the rendered width in pixels; omit it to use the pane width.
- Viewport-height units are resolved against `viewport_height` (default 900) so a
  preview never shrinks with its frame.

## Render and attach

```sh
curl -sk "<app>/<compiled stylesheet URL>" -o <scratch>/app.css   # e.g. the Vite dev entry with ?direct
ruby <skill>/scripts/previews.rb render --spec <scratch>/spec.json \
  --runner "docker exec -i <web-container> bin/rails runner -" --css <scratch>/app.css --out <scratch>/previews.json
ruby <skill>/scripts/series.rb previews --repo <root> --name <series> --revision <latest> --update <scratch>/previews.json
```

Find the runner and stylesheet from the project's own setup (its Docker or process
manager, layout `stylesheet`/`vite_stylesheet_tag`). `rails runner -` reads the
script from stdin, so nothing is written into the project. The command prints each
example's status and size; fix `unavailable` examples when the cause is the example
itself, and report genuine limits. Inspect the result in the browser before
delivering it: a clipped frame usually needs a `wrap` height or a wider `width`.

Each example keeps only the CSS rules whose classes, ids and elements appear in its
HTML (plus `:root`/`html`/`body` and used keyframes), inside its own sandboxed,
script-less frame, so previews never collide with each other or the review. Fonts
and scripts are never embedded. Previews are bound to the snapshot like QA evidence
and are dropped from new code revisions.

## Stand-in icons and images

The report works offline and never loads assets, and app icon fonts or URL images do
not survive into it. While rendering, the builder swaps them for labelled stand-ins:

- **Icons:** glyphs of common icon fonts (Font Awesome, Bootstrap Icons, Tabler,
  Remix, Material Design Icons, Phosphor, Line Awesome, Material Symbols/Icons
  ligatures) become Lucide SVGs, the icon set the report already bundles. A Lucide
  icon with the same name is used automatically. For the rest, the command prints
  `Icons without a Lucide match`; choose the closest Lucide icon by meaning (browse
  https://lucide.dev/icons) and add `"icon_map": {"fa-bars-filter": "list-filter"}` to
  the spec, then re-render. Each chosen name is verified against the Lucide CDN;
  unknown names and anything unmapped become a dashed placeholder. There is no
  built-in library-to-library table to go stale.
- **Images:** `data:` images already render and are kept. URL or relative images are
  listed as `Images needing a stand-in` with their alt text, size and classes. Use
  your own tools at that moment (web search, a browser or fetch) to pick a fitting
  photo from a free-to-use library such as Pexels or Unsplash, matching the image's
  role (an avatar needs a portrait, a hero a wide scene). Save a small copy beside the
  spec (about twice the rendered width, under 500 KiB), following your harness's
  download permissions, and add
  `"image_map": {"/assets/team/jane.png": {"path": "jane.jpg", "credit": "Photo by … on Unsplash"}}`,
  keyed by the listed `src`, then re-render. The builder embeds only real JPEG, PNG,
  WebP or GIF files; anything without a choice becomes a placeholder. No image API or
  key is involved.
- Lucide icons are cached under `~/.cache/dynamic-code-reviews` and must be plain
  shape SVG. `--offline` fetches nothing; a failing icon CDN only degrades to
  placeholders. The report marks every affected example “Stand-in
  assets” and states which icons/images are not final.
