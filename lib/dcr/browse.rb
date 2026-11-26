# frozen_string_literal: true

require 'json'
require 'net/http'
require 'openssl'
require 'open3'
require 'securerandom'
require 'shellwords'
require 'timeout'
require 'uri'

module DCR
  # browse (the browse extension and its CLI) is the browser QA records in. The server only asks it
  # whether it is ready, with `browse status --json`; installing it is the agent's job, on the
  # reviewer's click (`request`), because it changes the agent's own configuration.
  module Browse
    module_function

    WEB_STORE = 'https://chromewebstore.google.com/detail/mfnicocicmmlkpjnaffgihfjhdgjkdjg'
    # browse's own installers, from https://opencode.ai/product/browse
    INSTALLER = 'curl -fsSL https://opencode.ai/browse/install | bash'
    INSTALLER_WINDOWS = 'irm https://opencode.ai/browse/install.ps1 | iex'
    INSTALLER_NPM = 'npm install -g @opencode/browse'
    TIMEOUT = 3 # seconds; `browse status` answers in milliseconds when the relay is up

    # {'state' => 'ready' | 'not-installed' | 'extension-missing' | 'not-paired', 'next_step' => what
    # browse says to do (nil when ready), 'app' => whether the app's address answers (nil without an app)}.
    # status: `browse status --json`, parsed, or nil when the binary is missing.
    def check(app: nil, status: run_status)
      found = classify(status)
      found.merge('app' => app && answers?(app))
    end

    def classify(status)
      return {'state' => 'not-installed', 'next_step' => 'Install anomalyco/browse on this computer and add its extension to Chrome.'} unless status.is_a?(Hash)
      step = status['nextStep'].to_s.strip
      return {'state' => 'ready', 'next_step' => nil} if status['connected'] == true && step.empty?
      # The relay has never heard from an extension: it is not added yet. Otherwise it is added but not
      # connected to this computer (unpaired, or its browser is closed), which browse's step explains.
      seen = status['pairingState'].to_s != 'not-seen' && Array(status.dig('extension', 'browsers')).any?
      {'state' => seen ? 'not-paired' : 'extension-missing', 'next_step' => step.empty? ? nil : step}
    end

    # `browse status --json`, parsed; nil when browse is not installed. Output it cannot read counts as
    # not connected, so the reviewer is offered the setup rather than a QA review that cannot record.
    def run_status(binary: ENV.fetch('DCR_BROWSE_BIN', 'browse'))
      out = Open3.popen2(binary, 'status', '--json', err: File::NULL) do |input, output, wait|
        input.close
        Timeout.timeout(TIMEOUT) { output.read }
      rescue Timeout::Error
        Process.kill('KILL', wait.pid) rescue nil
        ''
      end
      value = JSON.parse(out)
      value.is_a?(Hash) ? value : {}
    rescue Errno::ENOENT, Errno::EACCES
      nil
    rescue JSON::ParserError
      {}
    end

    # The app's address answers HTTP, with any status. Only a HEAD: nothing is sent or kept, so a local
    # certificate is not checked here (the review's proxy checks it when it loads the app).
    def answers?(url)
      uri = URI(url)
      Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', verify_mode: OpenSSL::SSL::VERIFY_NONE, open_timeout: 1, read_timeout: 2) { |http| http.head(uri.request_uri) }
      true
    rescue StandardError
      false
    end

    # Install browse: the reviewer's click approves installing it and adding it to this agent. Queued
    # in the series state like a QA request, and returns {'id' => <its thread id>}.
    def request(series_dir:, state:, key:, origin:)
      manifest = JSON.parse(File.read(File.join(series_dir, 'manifest.json')))
      flags = "--repo #{Shellwords.escape(manifest.fetch('repo'))} --name #{Shellwords.escape(manifest.fetch('name'))}"
      dcr = Shellwords.escape(File.expand_path('../../bin/dcr', __dir__))
      id = "app-setup-#{SecureRandom.hex(4)}"
      text = <<~TEXT
        The reviewer pressed Install anomalyco/browse in the review. That approves installing browse on this computer and adding it to your agent's configuration. The review opened the browse extension's Chrome Web Store page in their browser (#{WEB_STORE}) so they can add it while you install the CLI.

        1. When `browse version` fails because there is no `browse` binary, install it with browse's own installer: #{INSTALLER} (Windows: #{INSTALLER_WINDOWS}; with npm: #{INSTALLER_NPM}). It puts the binary in ~/.local/bin; call it by that path when the shell does not find it yet.
        2. Add browse to this agent, so its later sessions have the browse MCP tools: browse install -a <this agent: claude, codex, opencode, cursor, …> --no-open --no-wait
        3. Use the `browse` CLI from this shell from now on (`browse <tool> --tab <id>`, `browse execute --file <script.js>`, `browse screenshot --tab <id> --output <file>`). This session needs neither the MCP tools nor a restart.
        4. Wait for the extension: run `browse status --json` every few seconds, for up to three minutes. While `nextStep` names something only the reviewer can do (add the extension, open its browser, pair it), tell them that step once in this thread: #{dcr} reply #{flags} #{id} '<the step>'. When it says to pair, run `browse pair --wait-seconds 180` and put the code it prints in that reply.
        5. When `connected` is true and `nextStep` is null, open the review in a browse tab: browse navigate '#{origin}/#overview'. QA records in the tab the reviewer looks at, and browse only drives tabs it opened.
        6. Then reply: #{dcr} reply #{flags} #{id} 'anomalyco/browse is ready. Continue in the review tab it just opened, and press Start QA review there.' If it never connected, say what is left instead.
      TEXT
      state.request_setup(key, id, text)
      {'id' => id}
    end
  end
end
