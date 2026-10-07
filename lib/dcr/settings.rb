# frozen_string_literal: true

require 'fileutils'
require 'json'

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

    def initialize(directory = self.class.default_directory)
      @path = File.join(File.expand_path(directory), 'settings.json')
    end

    attr_reader :path

    # Only known keys with known values; anything else in the file or request is dropped.
    def read
      return {} unless File.file?(@path)
      clean(JSON.parse(File.read(@path)))
    rescue JSON::ParserError
      {}
    end

    def write(input)
      raise ArgumentError, 'Settings must be an object' unless input.is_a?(Hash)
      merged = read.merge(clean(input))
      FileUtils.mkdir_p(File.dirname(@path), mode: 0o700)
      temporary = "#{@path}.#{Process.pid}.tmp"
      File.write(temporary, JSON.generate(merged), perm: 0o600)
      File.rename(temporary, @path)
      merged
    ensure
      File.unlink(temporary) if temporary && File.file?(temporary)
    end

    private

    def clean(input)
      return {} unless input.is_a?(Hash)
      input.select { |key, value| ALLOWED[key]&.include?(value) }
    end
  end
end
