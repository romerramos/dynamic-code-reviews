# frozen_string_literal: true

require 'fileutils'
require 'json'
require_relative 'settings'

module DCR
  # The reviewer's progress (viewed files, resolved comments, notes, their own comments), kept also
  # outside the worktree. The series folder holds it first, but a folder can be deleted or a worktree
  # torn down and the same review started again; its progress then comes back from here. One small
  # JSON file per series of a repository, holding the newest few revisions.
  class ProgressArchive
    LIMIT = 40

    def initialize(repo, series, directory: Settings.default_directory)
      name = series.to_s.gsub(/[^A-Za-z0-9_.-]/, '-')[0, 120]
      @path = File.join(File.expand_path(directory), 'progress', Settings.repo_key(repo), "#{name}.json")
    end

    attr_reader :path

    def read
      value = File.file?(@path) ? JSON.parse(File.read(@path)) : {}
      value.is_a?(Hash) ? value : {}
    rescue JSON::ParserError
      {}
    end

    def save(key, blob)
      FileUtils.mkdir_p(File.dirname(@path), mode: 0o700)
      File.open("#{@path}.lock", File::RDWR | File::CREAT, 0o600) do |lock|
        lock.flock(File::LOCK_EX)
        saved = read.tap { |all| all.delete(key) }.merge(key => blob).to_a.last(LIMIT).to_h
        temporary = "#{@path}.#{Process.pid}.tmp"
        File.write(temporary, JSON.generate(saved), perm: 0o600)
        File.rename(temporary, @path)
      end
    end

    # The progress saved under this key, else under the newest revision of the same code (a series
    # started again numbers its revisions afresh); nil when there is none.
    def find(key)
      saved = read
      return saved[key] if saved.key?(key)
      same_code = key.sub(/:\d+\z/, ':')
      saved.select { |name, _| name.start_with?(same_code) && name.delete_prefix(same_code).match?(/\A\d+\z/) }.max_by { |name, _| name.split(':').last.to_i }&.last
    end
  end
end
