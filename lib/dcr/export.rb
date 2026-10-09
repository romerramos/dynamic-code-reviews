# frozen_string_literal: true

require 'json'
require_relative 'page'
require_relative 'state'

module DCR
  # One self-contained HTML file: the series' current review with the reviewer's comments,
  # resolution marks and progress, and the agent's replies baked in. It opens offline with no
  # server; the conversation is read-only there. Embedded media is never dropped.
  module Export
    module_function

    LIMIT = 24 * 1024 * 1024 # the recorder's input budget; a larger file still exports, with a warning

    # Returns [html, warnings].
    def html(series_dir)
      series_dir = File.expand_path(series_dir)
      manifest = JSON.parse(File.read(File.join(series_dir, 'manifest.json')))
      revision = manifest.fetch('revisions').max_by { |entry| entry['number'] }
      key = "dynamic-review:#{revision['fingerprint']}:#{manifest.fetch('name')}:#{revision['number']}"
      page = File.read(File.join(series_dir, 'current.html'), encoding: 'UTF-8')
      state = State.new(series_dir)
      state.carry_forward(manifest['name'], manifest['revisions'])
      saved = state.read
      built = (saved['previews'][key] || {}).select { |_, preview| preview['status'] == 'ready' }.map { |path, preview| {'path' => path, 'title' => preview['title'], 'mocks' => preview['mocks'], 'html' => preview['html']} }
      data = {'key' => key, 'progress' => saved['blobs'][key], 'threads' => saved['threads'][key] || {}, 'previews' => built}

      result = Page.review(Page.payload(page), export: data)
      warnings = []
      warnings << "The export is #{(result.bytesize / 1024.0 / 1024).round(1)} MiB because of embedded media; it is complete, but large to share." if result.bytesize > LIMIT
      [result, warnings]
    end
  end
end
