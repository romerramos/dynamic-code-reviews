# frozen_string_literal: true

require 'json'
require 'securerandom'
require_relative '../../scripts/series'

module DCR
  # Attaches a clip or still the reviewer recorded in the served review to its series, through
  # the same `series qa` path an agent uses, so the same checks apply (unchanged code, size
  # budget, media type). It saves a new revision of the same code, which keeps the reviewer's
  # comments and threads (see State#carry_forward).
  module Evidence
    module_function

    RESULTS = %w[passed failed].freeze
    FIELD_LIMIT = 2_000

    # series_dir: .reviews/<name>. capture_dir: where the recorder saved the file.
    def attach(series_dir:, capture_dir:, input:)
      manifest = JSON.parse(File.read(File.join(series_dir, 'manifest.json')))
      file = capture_file(capture_dir, input['path'])
      title = text(input['title'], 'A title')
      observed = text(input['observed'], 'What you saw')
      expected = input['expected'].to_s.strip.then { |value| value.empty? ? 'The change behaves as intended.' : value[0, FIELD_LIMIT] }
      raise ArgumentError, 'Choose passed or failed' unless RESULTS.include?(input['result'])

      payload = ReviewSeries.latest(series_dir, ReviewSeries.manifest(series_dir))
      snapshot = payload['snapshot']
      review = payload['review']
      comment_id = input['comment_id'].to_s
      unless comment_id.empty? || Array(review['comments']).any? { |comment| comment['id'] == comment_id }
        raise ArgumentError, 'That comment is not part of this review'
      end

      flow = {'title' => title, 'result' => input['result'], 'expected' => expected, 'observed' => observed,
              'steps' => ['Recorded by the reviewer in the served review.']}
      flow['comment_id'] = comment_id unless comment_id.empty?
      media = {'path' => File.basename(file), 'caption' => title}
      media['comment_id'] = comment_id unless comment_id.empty?
      file.end_with?('.webm') ? flow['motion_preview'] = media.reject { |key, _| key == 'comment_id' } : flow['assets'] = [media]

      qa = Marshal.load(Marshal.dump(review['qa'] || {}))
      qa['fingerprint'] = snapshot['fingerprint']
      qa['status'] = 'partial' unless qa['status'] == 'complete'
      qa['summary'] = qa['summary'].to_s.strip.empty? ? 'Recorded by the reviewer.' : qa['summary']
      qa['environment'] = qa['environment'].to_s.strip.empty? ? 'Recorded by the reviewer in the served review; the running build was not verified.' : qa['environment']
      qa['flows'] = Array(qa['flows']) + [flow]

      update = File.join(capture_dir, "attach-#{SecureRandom.hex(4)}.json")
      File.write(update, JSON.generate(qa), perm: 0o600)
      begin
        number = manifest['revisions'].last['number']
        saved = ReviewSeries.qa(repo: manifest.fetch('repo'), name: manifest.fetch('name'), revision: number, update: update)
        {'revision' => number + 1, 'path' => saved}
      ensure
        File.unlink(update) if File.file?(update)
      end
    end

    # Only a regular file the recorder saved in its own directory.
    def capture_file(directory, path)
      raise ArgumentError, 'Choose a saved recording' if path.to_s.empty?
      file = File.expand_path(path.to_s)
      inside = File.directory?(File.dirname(file)) && File.realpath(File.dirname(file)) == File.realpath(directory)
      raise ArgumentError, 'That file is not in the capture directory' unless inside && File.file?(file) && !File.symlink?(file)
      raise ArgumentError, 'Only PNG stills and WebM clips can be attached' unless file.end_with?('.png', '.webm')
      file
    end

    def text(value, label)
      value = value.to_s.strip
      raise ArgumentError, "#{label} is required" if value.empty?
      value[0, FIELD_LIMIT]
    end
  end
end
