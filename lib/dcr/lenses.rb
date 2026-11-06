# frozen_string_literal: true

require 'json'
require 'open3'

module DCR
  # Review lenses: what the agent looks for when it reads a change. Each is a folder under
  # lenses/ with an adapter (LENS.md) and, for one taken from another author, that author's
  # files pinned to a commit with their license. lenses/lenses.json lists them. The reviewer
  # chooses one in the review page's Settings; the agent reads it with `dcr lens`.
  module Lenses
    DIR = File.expand_path('../../lenses', __dir__)
    MANIFEST = File.join(DIR, 'lenses.json')

    module_function

    def manifest = JSON.parse(File.read(MANIFEST))
    def all = manifest['lenses']
    def ids = all.map { |lens| lens['id'] }
    def default_id = manifest['default']
    def find(id) = all.find { |lens| lens['id'] == id }

    # The chosen lens, or the default when none was chosen or the chosen one is gone.
    def active(chosen) = find(chosen) || find(default_id)

    def paths(lens) = lens['read'].map { |file| File.join(DIR, file) }

    # What the page lists in its Settings: no paths, nothing it does not show.
    def choices(chosen)
      {'active' => active(chosen)['id'], 'default' => default_id,
       'lenses' => all.map { |lens| lens.slice('id', 'name', 'summary').merge('by' => lens.dig('upstream', 'repo')) }}
    end

    # What the agent reads before it reviews.
    def instructions(chosen)
      lens = active(chosen)
      source = lens['upstream'] ? " (from #{lens['upstream']['repo']} at #{lens['upstream']['commit'][0, 7]})" : ''
      chosen_line = lens['id'] == chosen ? 'chosen in the review page\'s Settings' : 'the default; the reviewer can choose another in the review page\'s Settings'
      <<~TEXT
        Review lens: #{lens['name']}#{source}, #{chosen_line}.
        Read these files before you judge the code. They decide what to look for; SKILL.md still decides how comments, findings and the review are written and posted.
        #{paths(lens).map { |path| "  #{path}" }.join("\n")}
      TEXT
    end

    # Fetches each upstream lens's files at the repository's current head and pins that commit.
    # A maintainer's command: it is the only part of lenses that uses the network.
    def update(only = nil, out: $stdout)
      data = manifest
      targets = data['lenses'].select { |lens| lens['upstream'] && (only.nil? || lens['id'] == only) }
      raise ArgumentError, "No upstream lens named #{only}. Known: #{ids.join(', ')}" if targets.empty?
      targets.each do |lens|
        upstream = lens['upstream']
        head, status = Open3.capture2('git', 'ls-remote', "https://github.com/#{upstream['repo']}", 'HEAD')
        commit = head.split.first if status.success?
        raise ArgumentError, "Could not reach #{upstream['repo']}" unless commit&.match?(/\A\h{40}\z/)
        changed = upstream['files'].count do |from, to|
          body, ok = Open3.capture2('curl', '-sfL', "https://raw.githubusercontent.com/#{upstream['repo']}/#{commit}/#{from}")
          raise ArgumentError, "#{upstream['repo']} has no #{from} at #{commit[0, 7]}; update lenses.json" unless ok.success?
          path = File.join(DIR, to)
          next false if File.file?(path) && File.read(path) == body
          File.write(path, body)
          true
        end
        upstream['commit'] = commit
        out.puts "#{lens['id']}: #{upstream['repo']} at #{commit[0, 7]}, #{changed} of #{upstream['files'].size} files changed#{changed.positive? ? '; reread its LENS.md against them' : ''}"
      end
      File.write(MANIFEST, "#{JSON.pretty_generate(data)}\n")
    end

    USAGE = <<~TEXT
      Usage: dcr lens                 The review lens to use now, and the files to read
             dcr lens list            Every lens, the active one marked
             dcr lens use <id>        Choose a lens (the review page's Settings does the same)
             dcr lens update [<id>]   Fetch the upstream lenses at their repository's head and pin it
    TEXT

    def cli(args, settings:, out: $stdout)
      case args
      in [] then out.puts instructions(settings.review_lens)
      in ['list']
        active_id = active(settings.review_lens)['id']
        all.each { |lens| out.puts "#{lens['id'] == active_id ? '*' : ' '} #{lens['id'].ljust(12)} #{lens['name']}: #{lens['summary']}" }
      in ['use', id] then settings.save_review_lens(id); out.puts "Review lens: #{find(id)['name']}. Reviews started from now on use it."
      in ['update'] then update(out: out)
      in ['update', id] then update(id, out: out)
      else raise ArgumentError, USAGE
      end
    end
  end
end
