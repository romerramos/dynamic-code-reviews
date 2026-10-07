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
    def attach(series_dir:, capture_dir:, input:) = attach_all(series_dir: series_dir, capture_dir: capture_dir, inputs: [input])

    # Evidence says who recorded it: the reviewer with their own pointer, or the agent (QA review),
    # whose pointer the review drew from its input events.
    SOURCES = {
      'reviewer' => {who: 'the reviewer', environment: 'Recorded by the reviewer in the served review; the running build was not verified.'},
      'agent' => {who: 'the agent', environment: "Recorded by the agent in the reviewer's shared review tab (Start QA review); the pointer is drawn from the agent's input events; the running build was not verified."}
    }.freeze

    # Several recordings from one session become one revision, not one revision each.
    # replace: :previous_qa (default for the agent) drops the last QA review's clips; :all drops every
    # recording made in the served review, for starting over when the reviewer asks.
    def attach_all(series_dir:, capture_dir:, inputs:, source: 'reviewer', replace: nil)
      raise ArgumentError, 'Choose at least one recording' if !inputs.is_a?(Array) || inputs.empty? || inputs.length > 20
      who = SOURCES.fetch(source)
      manifest = JSON.parse(File.read(File.join(series_dir, 'manifest.json')))
      payload = ReviewSeries.latest(series_dir, ReviewSeries.manifest(series_dir))
      snapshot = payload['snapshot']
      review = payload['review']
      flows = inputs.map { |input| flow(capture_dir, review, input, who[:who]).merge('source' => source) }

      qa = Marshal.load(Marshal.dump(review['qa'] || {}))
      qa['fingerprint'] = snapshot['fingerprint']
      # A finished QA review is complete; the reviewer's own recordings alone stay partial.
      qa['status'] = source == 'agent' || qa['status'] == 'complete' ? 'complete' : 'partial'
      # A QA review is a fresh take, not an addition: the agent's new clips replace the clips of the
      # previous QA review, so repeated runs never pile up. What the reviewer recorded stays.
      earlier = Array(qa['flows'])
      replace ||= source == 'agent' ? :previous_qa : :none
      drop = case replace
             when :previous_qa then ->(item) { agent_flow?(item) }
             when :all then ->(item) { agent_flow?(item) || item['source'] == 'reviewer' || Array(item['steps']).first.to_s.start_with?('Recorded by the reviewer') }
             else ->(_item) { false }
             end
      replaced = earlier.count(&drop)
      earlier = earlier.reject(&drop)
      qa['flows'] = earlier + flows
      # The summary and environment describe the recordings that remain, by who made them; text an
      # agent or a person wrote by hand is kept as it is.
      sources = qa['flows'].filter_map { |item| item['source'] || (agent_flow?(item) ? 'agent' : (Array(item['steps']).first.to_s.start_with?('Recorded by the reviewer') ? 'reviewer' : nil)) }.uniq.sort.reverse
      automatic_environment = [SOURCES['reviewer'][:environment], SOURCES['agent'][:environment]]
      # The summary says what the evidence shows (the agent recording it is the normal case and
      # not news); only the reviewer's own recordings are named, because those are the exception.
      summary = qa['summary'].to_s.strip
      if summary.empty? || summary.match?(/\A(Recorded by the (reviewer|agent)|QA review: \d+ recordings?|\d+ recordings?(, (all passed|\d+ failed)| by the reviewer))/)
        agent_flows = qa['flows'].select { |item| agent_flow?(item) }
        failed = agent_flows.count { |item| item['result'] == 'failed' }
        parts = []
        parts << "#{agent_flows.length} #{agent_flows.length == 1 ? 'recording' : 'recordings'}, #{failed.zero? ? 'all passed' : "#{failed} failed"}" if agent_flows.any?
        own = qa['flows'].length - agent_flows.length
        parts << "#{own} #{own == 1 ? 'recording' : 'recordings'} by the reviewer" if own.positive?
        qa['summary'] = "#{parts.join('; ')}."
      end
      environment = qa['environment'].to_s.strip
      if environment.empty? || automatic_environment.combination(1).to_a.push(automatic_environment, automatic_environment.reverse).map { |parts| parts.join(' ') }.include?(environment)
        qa['environment'] = (sources.empty? ? [source] : sources).map { |name| SOURCES.fetch(name)[:environment] }.join(' ')
      end

      update = File.join(capture_dir, "attach-#{SecureRandom.hex(4)}.json")
      File.write(update, JSON.generate(qa), perm: 0o600)
      begin
        number = manifest['revisions'].last['number']
        saved = ReviewSeries.qa(repo: manifest.fetch('repo'), name: manifest.fetch('name'), revision: number, update: update)
        {'revision' => number + 1, 'path' => saved, 'attached' => flows.length, 'replaced' => replaced}
      ensure
        File.unlink(update) if File.file?(update)
      end
    end

    def agent_flow?(item) = item['source'] == 'agent' || Array(item['steps']).first.to_s.start_with?('Recorded by the agent')

    def flow(capture_dir, review, input, who = 'the reviewer')
      raise ArgumentError, 'Each recording must be an object' unless input.is_a?(Hash)
      file = capture_file(capture_dir, input['path'])
      title = text(input['title'], 'A title')
      observed = text(input['observed'], 'What you saw')
      expected = input['expected'].to_s.strip.then { |value| value.empty? ? 'The change behaves as intended.' : value[0, FIELD_LIMIT] }
      raise ArgumentError, 'Choose passed or failed' unless RESULTS.include?(input['result'])
      comment_id = input['comment_id'].to_s
      unless comment_id.empty? || Array(review['comments']).any? { |comment| comment['id'] == comment_id }
        raise ArgumentError, 'That comment is not part of this review'
      end

      steps = input['page'].to_s.strip.empty? ? ["Recorded by #{who} in the served review."] : ["Recorded by #{who} on #{input['page'].to_s.strip[0, 500]}."]
      flow = {'title' => title, 'result' => input['result'], 'expected' => expected, 'observed' => observed, 'steps' => steps}
      flow['comment_id'] = comment_id unless comment_id.empty?
      media = {'path' => File.basename(file), 'caption' => title}
      media['comment_id'] = comment_id unless comment_id.empty?
      if file.end_with?('.webm')
        flow['motion_preview'] = media.reject { |key, _| key == 'comment_id' }
        # The recorder saves the clip's last frame beside it; the review uses it as the thumbnail.
        poster = file.sub(/\.webm\z/, '.poster.png')
        flow['assets'] = [media.merge('path' => File.basename(poster), 'caption' => "#{title} (last frame)")] if File.file?(poster) && !File.symlink?(poster)
      else
        flow['assets'] = [media]
      end
      flow
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
