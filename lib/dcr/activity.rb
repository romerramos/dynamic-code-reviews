# frozen_string_literal: true

require 'digest'
require 'json'
require 'time'
require_relative 'agents'

module DCR
  # What the agent's commands did to a series, one line each: which command, whether it worked or
  # the sentence it failed with, who ran it and from which copy of the skill. `dcr log` prints it,
  # so a step that never ran, or ran and was refused, can be seen afterwards. It never holds what
  # a comment, reply or file said.
  module Activity
    FILE = 'activity.log'
    KEPT = 2000 # lines
    ROOT = File.expand_path('../..', __dir__)
    module_function

    # detail: flags and counts, or the error's sentence. Never fails the command it describes.
    def record(directory, command, outcome, detail = nil)
      return unless directory && File.directory?(directory) && !File.symlink?(directory)
      line = JSON.generate({'at' => Time.now.utc.iso8601, 'command' => command, 'outcome' => outcome, 'detail' => detail&.to_s&.strip&.slice(0, 400),
                            'agent' => Agents.detect, 'skill' => ROOT, 'version' => version}.compact)
      File.open(File.join(directory, FILE), File::RDWR | File::CREAT, 0o600) do |file|
        file.flock(File::LOCK_EX)
        lines = file.readlines.last(KEPT - 1) << "#{line}\n"
        file.rewind
        file.write(lines.join)
        file.truncate(file.pos)
      end
    rescue SystemCallError, IOError
      nil
    end

    # The instructions this copy of the skill carries: two sessions on different text show apart.
    def version = @version ||= Digest::SHA256.file(File.join(ROOT, 'SKILL.md')).hexdigest[0, 10]

    def entries(directory)
      path = File.join(directory, FILE)
      File.file?(path) ? File.readlines(path).filter_map { |line| JSON.parse(line) rescue nil } : []
    end

    def text(directory)
      rows = entries(directory)
      return 'Nothing was recorded for this review yet.' if rows.empty?
      rows.map do |row|
        [Time.parse(row['at']).localtime.strftime('%Y-%m-%d %H:%M:%S'), row['outcome'] == 'ok' ? 'ok    ' : 'FAILED', row['command'], row['detail'],
         "(#{[row['agent'], "skill #{row['version']}"].compact.join(', ')})"].compact.join('  ')
      end.join("\n")
    end
  end
end
