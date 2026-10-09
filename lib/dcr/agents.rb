# frozen_string_literal: true

require 'open3'
require 'tmpdir'

module DCR
  # The coding agents a review can credit and consult: who wrote a comment or a reply, and how to
  # ask one for a second opinion from the terminal. An agent is a short slug (claude, codex, ...);
  # the page shows its name and its company's logo.
  module Agents
    module_function

    SLUG = /\A[a-z0-9][a-z0-9-]{0,29}\z/
    # Environment the CLIs set for the commands they run, so `dcr` can tell who called it.
    KNOWN = {
      'claude' => {'name' => 'Claude', 'company' => 'Anthropic', 'env' => %w[CLAUDECODE]},
      'codex' => {'name' => 'Codex', 'company' => 'OpenAI', 'env' => %w[CODEX_THREAD_ID CODEX_SANDBOX CODEX_MANAGED_BY_NPM]},
      'gemini' => {'name' => 'Gemini', 'company' => 'Google', 'env' => %w[GEMINI_CLI]},
      'grok' => {'name' => 'Grok', 'company' => 'xAI', 'env' => %w[GROK_CLI GROK_SESSION_ID]},
      'antigravity' => {'name' => 'Antigravity', 'company' => 'Google', 'env' => %w[ANTIGRAVITY_AGENT], 'bin' => 'agy'},
      'cursor' => {'name' => 'Cursor', 'company' => 'Cursor', 'env' => %w[CURSOR_AGENT]},
      'opencode' => {'name' => 'opencode', 'company' => 'opencode', 'env' => %w[OPENCODE]}
    }.freeze
    TIMEOUT = 300

    # Left by Claude Code for the commands it runs; a nested `claude -p` refuses to start under them.
    NESTED = %w[CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_PID].freeze

    # How to ask each one a single question, read-only, with nothing on its screen to answer, on the
    # model and effort the reviewer chose (nil: the CLI's own setting).
    # Each returns [command, stdin]; the answer is stdout, or the file named by `out`.
    RUNNERS = {
      'claude' => ->(prompt, _out, model, effort) { [%w[claude -p --tools Read,Grep,Glob] + flag('--model', model) + flag('--effort', effort), prompt] },
      'codex' => lambda do |prompt, out, model, effort|
        [['codex', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-o', out] + flag('-m', model) + flag('-c', effort && "model_reasoning_effort=\"#{effort}\"") + ['-'], prompt]
      end,
      'gemini' => ->(prompt, _out, model, _effort) { [['gemini', '-p', prompt, '--approval-mode', 'plan', '-o', 'text'] + flag('-m', model), nil] },
      'grok' => ->(prompt, _out, model, effort) { [['grok', '-p', prompt, '--permission-mode', 'plan'] + flag('-m', model) + flag('--reasoning-effort', effort), nil] },
      # Antigravity's model names carry the effort (gemini-3.8-flash-high); it refuses --effort beside one.
      'antigravity' => ->(prompt, _out, model, _effort) { [['agy', '-p', prompt, '--mode', 'plan'] + flag('--model', model), nil] },
      # opencode's built-in plan agent cannot edit, and a headless run denies anything it would ask for.
      'opencode' => ->(prompt, _out, model, _effort) { [['opencode', 'run', '--agent', 'plan'] + flag('-m', model) + [prompt], nil] }
    }.freeze

    # The efforts an agent's CLI takes, where they are not listed per model (Codex lists them per
    # model; Antigravity and opencode build them into the model's name).
    EFFORTS = {
      'claude' => %w[low medium high xhigh max],
      'grok' => %w[low medium high]
    }.freeze

    # A CLI that would stop to ask for a sign-in is left out rather than left hanging.
    READY = {
      'gemini' => -> { %w[GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENAI_USE_VERTEXAI].any? { |key| ENV[key].to_s != '' } || File.file?(File.join(Dir.home, '.gemini', 'oauth_creds.json')) }
    }.freeze

    def flag(name, value) = value.to_s.empty? ? [] : [name, value.to_s]

    def name(slug) = KNOWN.dig(slug, 'name') || slug.to_s.capitalize

    def check(slug)
      slug = slug.to_s.strip.downcase
      raise ArgumentError, 'An agent is a short lowercase name, like claude or codex' unless slug.match?(SLUG)
      slug
    end

    # The agent running this command, from the variables its CLI sets; nil when it cannot tell.
    def detect(env = ENV) = KNOWN.find { |_, agent| agent['env'].any? { |name| env[name].to_s != '' } }&.first

    # The command an agent's CLI goes by (Antigravity's is `agy`).
    def bin(slug) = KNOWN.dig(slug, 'bin') || slug

    def installed?(slug) = RUNNERS.key?(slug) && ENV.fetch('PATH', '').split(File::PATH_SEPARATOR).any? { |dir| File.executable?(File.join(dir, bin(slug))) }

    # The adversaries the reviewer chose (see Settings#adversaries), in their order, that can answer
    # now: installed, and not the author checking itself. An agent checks its own work only on a
    # model the reviewer named, since the same model with the same settings mostly agrees with itself.
    # The first answers in the conversation; the rest weigh in beside it.
    def panel(author, adversaries)
      adversaries.select { |entry| installed?(entry['agent']) && (entry['agent'] != author || entry['model']) }
    end

    # One question to one agent, run in `dir`. Returns the answer, or raises ArgumentError with a
    # sentence the page can show.
    def ask(slug, prompt, dir:, model: nil, effort: nil, timeout: TIMEOUT)
      runner = RUNNERS[slug] or raise ArgumentError, "#{name(slug)} cannot be asked from here yet"
      raise ArgumentError, "#{name(slug)} is not signed in. Run `#{bin(slug)}` once to sign in." unless READY.fetch(slug, -> { true }).call
      out = File.join(Dir.tmpdir, "dcr-#{slug}-#{Process.pid}-#{rand(1 << 30)}.txt")
      command, input = runner.call(prompt, out, model, effort)
      env = NESTED.to_h { |key| [key, nil] }
      stdout, stderr, status = run(env, command, input, dir, timeout, slug)
      answer = File.file?(out) ? File.read(out) : stdout
      raise ArgumentError, "#{name(slug)} is not signed in. Run `#{bin(slug)}` once to sign in." if (stdout + stderr).match?(/authenticat|sign in|log ?in|oauth_creds/i) && (!status.success? || answer.strip.empty?)
      raise ArgumentError, "#{name(slug)} did not answer (#{(stderr.lines.last || 'exit ' + status.exitstatus.to_s).strip[0, 160]})" unless status.success? && !answer.strip.empty?
      answer.strip
    ensure
      File.unlink(out) if out && File.exist?(out)
    end

    def run(env, command, input, dir, timeout, slug)
      Open3.popen3(env, *command, chdir: dir, pgroup: true) do |stdin, stdout, stderr, wait|
        stdin.write(input) if input
        stdin.close
        readers = [stdout, stderr].map { |io| Thread.new { io.read }.tap { |reader| reader.report_on_exception = false } }
        unless wait.join(timeout)
          # The whole process group, so a CLI's own children stop too; the readers then see the end.
          %w[TERM KILL].each { |signal| Process.kill(signal, -wait.pid) rescue nil; break if wait.join(2) }
          readers.each { |reader| reader.join(2) }
          took = timeout < 60 ? "#{timeout} seconds" : "#{timeout / 60} minutes"
          raise ArgumentError, "#{name(slug)} took longer than #{took}"
        end
        [readers[0].value.to_s, readers[1].value.to_s, wait.value]
      end
    rescue Errno::ENOENT
      raise ArgumentError, "#{name(slug)} is not installed"
    end
  end
end
