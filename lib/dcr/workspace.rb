# frozen_string_literal: true

require 'json'
require 'open3'

module DCR
  # The name and running app a workspace tool gave this checkout, in <git dir>/workspace.json:
  # {"name": "orion", "app": "https://app.orion.test"}. Apps that make worktrees (T3 Code, Paseo)
  # name the folder their own way, like t3-c6839a9e; this is the name the reviewer knows it by.
  # Each worktree has its own git dir, which git never commits. The workspace kit's ws writes it;
  # any tool may.
  module Workspace
    module_function

    FILE = 'workspace.json'
    NAME = /\A[A-Za-z0-9][A-Za-z0-9._-]{0,39}\z/
    APP = %r{\Ahttps?://[^\s/]+[^\s]*\z}i

    # {'name', 'app', 'path'} with the usable fields, or nil without a marker.
    def find(repo)
      dir, status = Open3.capture2('git', '-C', repo.to_s, 'rev-parse', '--absolute-git-dir', err: File::NULL)
      return unless status.success?

      path = File.join(dir.strip, FILE)
      return unless File.file?(path) && !File.symlink?(path)

      data = JSON.parse(File.read(path))
      return unless data.is_a?(Hash)

      found = {'name' => data['name'].to_s.strip, 'app' => data['app'].to_s.strip}
      found.delete('name') unless found['name'].match?(NAME)
      found.delete('app') unless found['app'].match?(APP)
      found.merge('path' => path) unless found.empty?
    rescue JSON::ParserError, SystemCallError
      nil
    end
  end
end
