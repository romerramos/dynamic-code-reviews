# frozen_string_literal: true

require 'digest'
require 'fileutils'
require 'json'
require 'open3'

module DCR
  # The reviewer's display preferences, shared by every review they serve. Stored once per
  # user, unlike review progress, which belongs to one review.
  class Settings
    KEY = 'dynamic-review:settings' # where the report page keeps them in the browser
    ALLOWED = {
      'colorMode' => %w[system light dark],
      'syntaxTheme' => %w[classic github one solarized dracula],
      'ignoreWhitespace' => [true, false]
    }.freeze

    def self.default_directory = ENV['DCR_CONFIG_DIR'] || File.join(Dir.home, '.config', 'dcr')

    # One name per repository, the same in all its worktrees, for what is kept outside them
    # (QA notes, the reviewer's progress): the main checkout's folder name and a short hash of its path.
    def self.repo_key(repo)
      common, status = Open3.capture2('git', '-C', repo.to_s, 'rev-parse', '--path-format=absolute', '--git-common-dir', err: File::NULL)
      root = status.success? && !common.strip.empty? ? File.dirname(common.strip) : File.expand_path(repo.to_s)
      "#{File.basename(root)}-#{Digest::SHA256.hexdigest(root)[0, 8]}"
    end

    def initialize(directory = self.class.default_directory)
      @path = File.join(File.expand_path(directory), 'settings.json')
    end

    attr_reader :path

    # Only known keys with known values; anything else in the file or request is dropped.
    def read = clean(saved)

    def write(input)
      raise ArgumentError, 'Settings must be an object' unless input.is_a?(Hash)
      store(read.merge(clean(input)))
    end

    # The agents that check this reviewer's reviews, in order: [{agent, model, effort}], where a nil
    # model or effort is the CLI's own setting. Empty means none. Set from the review page, kept
    # here so every review on this computer uses them; the page's display settings never carry them.
    def adversaries = adversary_list(saved['adversaries'])

    def save_adversaries(list)
      raise ArgumentError, 'Adversaries must be a list' unless list.is_a?(Array)
      store(read, adversary_list(list, strict: true))
      adversaries
    end

    private

    MODEL = %r{\A[\w.:/@#+-]{1,120}\z}
    EFFORT = /\A[a-z]{2,12}\z/

    def saved
      return {} unless File.file?(@path)
      value = JSON.parse(File.read(@path))
      value.is_a?(Hash) ? value : {}
    rescue JSON::ParserError
      {}
    end

    # The page writes display settings and adversaries separately; each write keeps the other.
    def store(display, adversaries = self.adversaries)
      merged = adversaries.empty? ? display : display.merge('adversaries' => adversaries)
      FileUtils.mkdir_p(File.dirname(@path), mode: 0o700)
      temporary = "#{@path}.#{Process.pid}.tmp"
      File.write(temporary, JSON.generate(merged), perm: 0o600)
      File.rename(temporary, @path)
      display
    ensure
      File.unlink(temporary) if temporary && File.file?(temporary)
    end

    def adversary_list(list, strict: false)
      return [] unless list.is_a?(Array)
      list.each_with_object([]) do |entry, out|
        agent = entry['agent'].to_s if entry.is_a?(Hash)
        model, effort = entry.values_at('model', 'effort').map { |value| value.to_s.strip.empty? ? nil : value.to_s.strip } if agent
        valid = agent&.match?(/\A[a-z0-9][a-z0-9-]{0,29}\z/) && (model.nil? || model.match?(MODEL)) && (effort.nil? || effort.match?(EFFORT)) && out.none? { |seen| seen['agent'] == agent }
        raise ArgumentError, "Invalid adversary: #{entry.inspect[0, 120]}" if strict && !valid
        out << {'agent' => agent, 'model' => model, 'effort' => effort} if valid
      end.first(20)
    end

    def clean(input)
      return {} unless input.is_a?(Hash)
      input.select { |key, value| ALLOWED[key]&.include?(value) }
    end
  end
end
