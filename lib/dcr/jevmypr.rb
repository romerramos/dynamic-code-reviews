# frozen_string_literal: true

require 'json'
require 'net/http'
require 'openssl'
require 'time'
require 'uri'

module DCR
  # Asks JevMyPR, an outside service, how much review a diff needs: a human's, an LLM's or none.
  # The request carries the review's title and every changed file's name and patch, so the review
  # server never calls this for a repository whose reviewer turned it off (Settings#jevmypr).
  class JevMyPR
    URL = 'https://jevmypr.romerramos.me/api/verdicts'
    VERDICTS = %w[human llm none].freeze
    FILES_LIMIT = 3000
    PATCH_LIMIT = 1_000_000 # JevMyPR takes 1 MB of patches in a 2 MB body; later files go without theirs
    OPEN_SECONDS = 8
    READ_SECONDS = 90 # the call is synchronous: JevMyPR answers when Jev has
    UNREACHABLE = [SocketError, SystemCallError, IOError, Timeout::Error, OpenSSL::SSL::SSLError, Net::ProtocolError, EOFError].freeze

    # post: callable(uri, json) returning [status, headers, body], so tests need no network.
    def initialize(url: ENV.fetch('DCR_JEVMYPR_URL', URL), post: nil)
      @uri = URI(url)
      @post = post || method(:post)
    end

    def host = @uri.host

    # What is sent for a snapshot's files ({path, patch, hunks}): GitHub's shape, hunks only.
    def self.request(files, title: nil)
      room = PATCH_LIMIT
      listed = files.first(FILES_LIMIT).map do |file|
        header = file['patch'].to_s[/\A.*?(?=^@@ |\z)/m].to_s
        entry = {'filename' => file['path'], 'status' => status(header)}
        entry['previous_filename'] = header[/^rename from (.+)$/, 1] if entry['status'] == 'renamed'
        patch = Array(file['hunks']).map { |hunk| hunk['patch'].to_s.chomp }.join("\n")
        if !patch.empty? && patch.bytesize <= room
          room -= patch.bytesize
          entry['patch'] = patch
        end
        entry.compact
      end
      {'title' => title, 'files' => listed}.compact
    end

    def self.status(header)
      return 'added' if header.match?(/^new file mode /)
      return 'removed' if header.match?(/^deleted file mode /)
      header.match?(/^rename from /) ? 'renamed' : 'modified'
    end

    # Always a hash the page can show: {'status' => 'ready', verdict, confidence, files, ...} or
    # {'status' => 'error', code, message, retry_at}. files maps each path to its verdict, or to
    # nil with the reason in skipped.
    def ask(request)
      status, headers, body = @post.call(@uri, JSON.generate(request))
      data = begin
        JSON.parse(body.to_s)
      rescue JSON::ParserError
        nil
      end
      return ready(data) if status == 200 && data.is_a?(Hash) && VERDICTS.include?(data['verdict'])
      refused(status, headers || {}, data.is_a?(Hash) ? data : {})
    rescue *UNREACHABLE => error
      failure('unreachable', "JevMyPR could not be reached (#{error.class.name.split('::').last}).")
    end

    private

    def ready(data)
      listed = Array(data['files']).select { |file| file.is_a?(Hash) && file['filename'].is_a?(String) }
      url = data['url'].to_s
      {'status' => 'ready', 'verdict' => data['verdict'], 'confidence' => data['confidence'].is_a?(Numeric) ? data['confidence'].to_f.clamp(0.0, 1.0) : nil,
       'files' => listed.to_h { |file| [file['filename'], VERDICTS.include?(file['verdict']) ? file['verdict'] : nil] },
       'skipped' => listed.select { |file| file['skipped'] }.to_h { |file| [file['filename'], file['skipped'].to_s[0, 40]] },
       'truncated' => data['diff_truncated'] == true,
       'url' => url.start_with?("#{@uri.scheme}://#{@uri.host}") ? url[0, 500] : nil, # only a link to JevMyPR itself
       'at' => Time.now.utc.iso8601}
    end

    def refused(status, headers, data)
      wait = headers.to_h { |name, value| [name.to_s.downcase, value] }['retry-after'].to_s
      retry_at = if wait.match?(/\A\d+\z/) then Time.now + wait.to_i
                 elsif !wait.empty? then (Time.httpdate(wait) rescue nil)
                 end
      message = data['message'].to_s.strip
      failure(data['error'].to_s[/\A[a-z_]{1,40}\z/] || "http_#{status}", message.empty? ? "JevMyPR answered #{status}." : message[0, 400], retry_at)
    end

    def failure(code, message, retry_at = nil)
      {'status' => 'error', 'code' => code, 'message' => message, 'retry_at' => retry_at&.utc&.iso8601, 'at' => Time.now.utc.iso8601}
    end

    def post(uri, json)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == 'https'
      http.open_timeout = OPEN_SECONDS
      http.read_timeout = READ_SECONDS
      response = http.post(uri.request_uri, json, 'Content-Type' => 'application/json', 'Accept' => 'application/json', 'User-Agent' => 'dynamic-code-reviews')
      [response.code.to_i, response.each_header.to_h, response.body]
    end
  end
end
