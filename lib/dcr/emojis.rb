# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'net/http'
require 'open3'
require 'time'
require 'timeout'
require_relative 'settings'

module DCR
  # The emoji names a reviewer can type between colons (:thinking:), as GitHub knows them: the list
  # GitHub keeps for its own site (github/gemoji, db/emoji.json), so the names are the ones they
  # would type there and new emojis arrive without a change here. GitHub's /emojis address has the
  # same names but only image files, whose names drop the joiners a combined emoji needs. Kept in
  # the reviewer's config folder and fetched again after a week; with no network the last copy is
  # used, and with none at all there is simply no completion.
  module Emojis
    module_function

    FILE = 'emojis.json'
    FRESH_SECONDS = 7 * 24 * 60 * 60
    FETCH_SECONDS = 8
    SOURCE = 'repos/github/gemoji/contents/db/emoji.json'
    RAW = 'https://raw.githubusercontent.com/github/gemoji/master/db/emoji.json'

    # {name => emoji}. fetch: callable returning gemoji's entries, for tests.
    def list(directory: Settings.default_directory, fetch: method(:fetch), now: Time.now)
      path = File.join(File.expand_path(directory), FILE)
      saved = read(path)
      return saved['emojis'] if saved && now - Time.parse(saved['fetched_at']) < FRESH_SECONDS
      emojis = names(fetch.call)
      return saved ? saved['emojis'] : {} if emojis.empty?
      FileUtils.mkdir_p(File.dirname(path), mode: 0o700)
      File.write(path, JSON.generate('fetched_at' => now.utc.iso8601, 'emojis' => emojis), perm: 0o600)
      emojis
    rescue StandardError
      saved ? saved['emojis'] : {}
    end

    def read(path)
      return unless File.file?(path)
      saved = JSON.parse(File.read(path))
      saved if saved['emojis'].is_a?(Hash) && saved['fetched_at'].is_a?(String)
    rescue JSON::ParserError
      nil
    end

    # Every name an emoji goes by: [{'emoji' => '🤔', 'aliases' => ['thinking']}, ...] to {'thinking' => '🤔'}.
    def names(entries)
      Array(entries).each_with_object({}) do |entry, out|
        next unless entry.is_a?(Hash) && entry['emoji'].is_a?(String) && !entry['emoji'].empty?
        Array(entry['aliases']).each { |name| out[name] = entry['emoji'] if name.is_a?(String) && name.match?(/\A[a-z0-9_+-]+\z/) }
      end
    end

    # Through the GitHub CLI when it is here (signed in, no rate limit to meet), else the public file.
    def fetch(gh: ENV.fetch('DCR_GH', 'gh'))
      Timeout.timeout(FETCH_SECONDS) do
        out, _err, status = Open3.capture3(gh, 'api', SOURCE, '-H', 'Accept: application/vnd.github.raw')
        return JSON.parse(out) if status.success?
      rescue SystemCallError, JSON::ParserError
        nil
      end
      uri = URI(RAW)
      response = Net::HTTP.start(uri.host, 443, use_ssl: true, open_timeout: FETCH_SECONDS, read_timeout: FETCH_SECONDS) { |http| http.get(uri.path, 'User-Agent' => 'dynamic-code-reviews') }
      response.is_a?(Net::HTTPSuccess) ? JSON.parse(response.body) : []
    rescue StandardError
      []
    end
  end
end
