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
    # Antigravity is not here: headless, it is refused even reading a file, so it never answers.
    RUNNERS = {
      'claude' => ->(prompt, _out, model, effort) { [%w[claude -p --tools Read,Grep,Glob,WebSearch,WebFetch --allowedTools WebSearch,WebFetch] + flag('--model', model) + flag('--effort', effort), prompt] },
      'codex' => lambda do |prompt, out, model, effort|
        [['codex', '--search', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-o', out] + flag('-m', model) + flag('-c', effort && "model_reasoning_effort=\"#{effort}\"") + ['-'], prompt]
      end,
      'gemini' => ->(prompt, _out, model, _effort) { [['gemini', '-p', prompt, '--approval-mode', 'plan', '-o', 'text'] + flag('-m', model), nil] },
      'grok' => ->(prompt, _out, model, effort) { [['grok', '-p', prompt, '--permission-mode', 'plan'] + flag('-m', model) + flag('--reasoning-effort', effort), nil] },
      # opencode's built-in plan agent cannot edit, and a headless run denies anything it would ask for.
      'opencode' => ->(prompt, _out, model, _effort) { [['opencode', 'run', '--agent', 'plan'] + flag('-m', model) + [prompt], nil] }
    }.freeze

    # Added when an agent is asked as an adversary: only its reading and web tools, so it reads and
    # searches to its answer. A Grok that reached for the shell ended its turn there, at "I'll check...".
    ADVERSARY = {
      'grok' => %w[--tools read_file,grep,list_dir,web_search,web_fetch --allow web_search --allow web_fetch]
    }.freeze

    # The exit code an agent's CLI gives when one of its tools failed but it answered all the same
    # (opencode, after a web search it could not run).
    ANSWERED_ANYWAY = {'opencode' => 1}.freeze

    # The efforts an agent's CLI takes, where they are not listed per model (Codex lists them per
    # model; opencode builds them into the model's name).
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
    # adversary: asked to check another's work, with only what ADVERSARY leaves it.
    def ask(slug, prompt, dir:, model: nil, effort: nil, timeout: TIMEOUT, adversary: false)
      runner = RUNNERS[slug] or raise ArgumentError, "#{name(slug)} cannot be asked from here yet"
      raise ArgumentError, "#{name(slug)} is not signed in. Run `#{bin(slug)}` once to sign in." unless READY.fetch(slug, -> { true }).call
      out = File.join(Dir.tmpdir, "dcr-#{slug}-#{Process.pid}-#{rand(1 << 30)}.txt")
      command, input = runner.call(prompt, out, model, effort)
      command += ADVERSARY.fetch(slug, []) if adversary
      env = NESTED.to_h { |key| [key, nil] }
      stdout, stderr, status = run(env, command, input, dir, timeout, slug)
      # A model that thinks aloud on stdout (opencode's big-pickle) closes its thinking with </think>.
      answer = (File.file?(out) ? File.read(out) : stdout).sub(%r{\A.*</think>}m, '')
      ok = status.success? || status.exitstatus == ANSWERED_ANYWAY[slug]
      raise ArgumentError, "#{name(slug)} is not signed in. Run `#{bin(slug)}` once to sign in." if (stdout + stderr).match?(/authenticat|sign in|log ?in|oauth_creds/i) && (!ok || answer.strip.empty?)
      raise ArgumentError, "#{name(slug)} did not answer (#{failure(stderr, status)})" unless ok && !answer.strip.empty?
      answer.strip
    ensure
      File.unlink(out) if out && File.exist?(out)
    end

    # Why a CLI failed, in a sentence: the API's own message when it printed one as JSON (Codex's
    # `ERROR: {"error":{"message":"The 'x' model is not supported..."}}`), else its last line.
    def failure(stderr, status)
      said = stderr.scan(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/).last&.first
      said = said.gsub(/\\(["\\])/, '\\1') if said
      (said || stderr.lines.last || "exit #{status.exitstatus}").strip[0, 240]
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
