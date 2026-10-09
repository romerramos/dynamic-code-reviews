# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'time'
require_relative 'agents'
require_relative 'settings'

module DCR
  # What each agent CLI on this computer offers as an adversary: whether it is installed, whether
  # it says it is signed in, the models it lists with their efforts, and how its last real answer
  # went. Listing asks no model anything, so it spends no tokens. It is kept for a few minutes,
  # since some CLIs ask their service for the list.
  module AgentCatalog
    module_function

    TTL = 600
    LIST_TIMEOUT = 15
    # What the page fills in when an agent is turned on; the reviewer can change it.
    SUGGESTED = {'opencode' => 'opencode/big-pickle'}.freeze
    # `claude --model` takes these names (or a full model name); Claude lists none.
    CLAUDE_MODELS = %w[fable opus sonnet].freeze
    FREE = %r{-free\z|\Aopencode/big-pickle\z}

    @cache = nil
    @lock = Mutex.new

    # [{slug, name, installed, ready (true, false or nil when the CLI cannot say), models, efforts,
    # default_model and default_effort (what the CLI runs when given none, when it says), suggested,
    # last}], one per agent the review can ask, installed ones first.
    def list(fresh: false)
      @lock.synchronize do
        @cache = nil if fresh || (@cache && Time.now - @cache[0] > TTL)
        @cache ||= [Time.now, Agents::RUNNERS.keys.map { |slug| Thread.new { probe(slug) } }.map(&:value)]
        last = Results.read
        @cache[1].map { |entry| entry.merge('last' => last[entry['slug']]) }.sort_by { |entry| entry['installed'] ? 0 : 1 }
      end
    end

    def probe(slug)
      entry = {'slug' => slug, 'name' => Agents.name(slug), 'bin' => Agents.bin(slug), 'installed' => Agents.installed?(slug), 'ready' => nil, 'models' => [], 'efforts' => Agents::EFFORTS.fetch(slug, []), 'suggested' => SUGGESTED[slug]}
      return entry unless entry['installed']
      send("probe_#{slug}", entry)
      entry
    end

    def probe_claude(entry)
      out, = capture('claude', %w[claude auth status])
      entry['ready'] = JSON.parse(out)['loggedIn'] == true if out
      entry['models'] = CLAUDE_MODELS.map { |id| {'id' => id} }
    rescue JSON::ParserError
      nil
    end

    def probe_codex(entry)
      _, ok = capture('codex', %w[codex login status])
      entry['ready'] = ok
      out, = capture('codex', %w[codex debug models])
      entry['models'] = codex_models(out) if out
      # What Codex runs when it is given no model or effort: its own config, then the model's default.
      config = File.read(File.join(ENV['CODEX_HOME'] || File.join(Dir.home, '.codex'), 'config.toml')) rescue ''
      model, effort = codex_defaults(config)
      if model
        entry['models'] << {'id' => model} unless entry['models'].any? { |listed| listed['id'] == model }
        entry['default_model'] = model
      end
      entry['default_effort'] = effort if effort
    end

    # The top-level model and model_reasoning_effort of a Codex config.toml (before any [table]).
    def codex_defaults(toml)
      top = toml.to_s.split(/^\s*\[/, 2).first.to_s
      %w[model model_reasoning_effort].map { |name| top[/^\s*#{name}\s*=\s*"([^"\n]+)"/, 1] }
    end

    def probe_grok(entry)
      out, ok = capture('grok', %w[grok models])
      entry['ready'] = signed_in(out, ok)
      entry['models'] = grok_models(out) if ok
      entry['default_model'] = entry['models'].find { |model| model['default'] }&.dig('id')
    end

    def probe_antigravity(entry)
      out, ok = capture('antigravity', %w[agy models])
      # Its list never says who is signed in, only that nobody is.
      entry['ready'] = false if signed_in(out, ok) == false
      entry['models'] = agy_models(out) if ok
    end

    def probe_opencode(entry)
      out, ok = capture('opencode', %w[opencode models])
      entry['models'] = opencode_models(out) if ok
    end

    def probe_gemini(entry)
      entry['ready'] = Agents::READY['gemini'].call
    end

    # true when the CLI says it is logged in, false when it says it is not, nil when it does not say.
    def signed_in(out, ok)
      return false if out.to_s.match?(/not (?:logged|signed) in|please (?:log|sign) ?in|unauthori[sz]ed/i) || (!ok && out.to_s.match?(/log ?in|sign ?in|authenticat/i))
      return true if out.to_s.match?(/\b(?:logged|signed) in\b/i)
      nil
    end

    # [stdout and stderr, success], or [nil, false] when the CLI did not run or took too long.
    def capture(slug, command)
      stdout, stderr, status = Agents.run(Agents::NESTED.to_h { |key| [key, nil] }, command, nil, Dir.home, LIST_TIMEOUT, slug)
      ["#{stdout}\n#{stderr}".strip, status.success?]
    rescue ArgumentError, SystemCallError
      [nil, false]
    end

    # --- each CLI's own list ------------------------------------------------------------------------

    def codex_models(text)
      JSON.parse(text[/\{.*\}/m].to_s).fetch('models', []).reject { |model| model['visibility'] == 'hide' }.map do |model|
        {'id' => model['slug'], 'label' => model['display_name'], 'efforts' => Array(model['supported_reasoning_levels']).map { |level| level['effort'] }, 'default_effort' => model['default_reasoning_level']}.compact
      end
    rescue JSON::ParserError, NoMethodError
      []
    end

    def grok_models(text)
      text.to_s.lines.filter_map do |line|
        match = line.match(/\A\s*[*-]\s+(\S+)(\s+\(default\))?/) or next
        {'id' => match[1], 'default' => match[2] ? true : nil}.compact
      end
    end

    def agy_models(text)
      text.to_s.lines.filter_map do |line|
        id, label = line.strip.split("\t", 2)
        {'id' => id, 'label' => label&.strip}.compact if label && id.match?(/\A[\w.:-]+\z/)
      end
    end

    def opencode_models(text)
      text.to_s.lines.map(&:strip).grep(%r{\A[\w.-]+/[\w.:@-]+\z}).map { |id| {'id' => id, 'free' => id.match?(FREE) || nil}.compact }
    end

    # How each agent's last real answer went, kept beside the settings so every review on this
    # computer knows: for a CLI with no status command, this is the honest signal.
    module Results
      module_function

      def path = File.join(File.expand_path(Settings.default_directory), 'agent-results.json')

      def read
        File.file?(path) ? JSON.parse(File.read(path)) : {}
      rescue JSON::ParserError
        {}
      end

      def record(slug, error = nil)
        FileUtils.mkdir_p(File.dirname(path), mode: 0o700)
        File.open("#{path}.lock", File::RDWR | File::CREAT, 0o600) do |lock|
          lock.flock(File::LOCK_EX)
          results = read.merge(slug => {'ok' => error.nil?, 'at' => Time.now.utc.iso8601, 'error' => error&.to_s&.strip&.slice(0, 300)}.compact)
          temporary = "#{path}.#{Process.pid}.tmp"
          File.write(temporary, JSON.generate(results), perm: 0o600)
          File.rename(temporary, path)
        end
      end
    end
  end
end
