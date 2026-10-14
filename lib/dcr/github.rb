# frozen_string_literal: true

require 'json'
require 'net/http'
require 'open3'
require 'timeout'

module DCR
  # Posts the reviewer's comments to the pull request with the GitHub CLI already signed in on
  # this computer. Only a click in the review page posts, one request per click; the agent is
  # never involved. The pull request and the reviewed commit come from the saved revision, never
  # from the request, so the page can only choose what to say and on which lines.
  class GitHub
    Error = Class.new(StandardError)
    PR_URL = %r{\Ahttps://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)\z}
    EVENTS = %w[COMMENT APPROVE REQUEST_CHANGES].freeze
    BODY_LIMIT = 65_000 # GitHub's limit is 65,536 characters
    CALL_SECONDS = 12   # below the server's per-request limit
    STATUS_SECONDS = 60
    AVATAR_HOST = 'avatars.githubusercontent.com'
    AVATAR_BYTES = 200_000
    # The avatar's type and bytes, or nil. Small, from GitHub's own avatar host only.
    AVATAR = lambda do |url|
      uri = URI(url)
      return nil unless uri.scheme == 'https' && uri.host == AVATAR_HOST

      uri.query = [uri.query, 's=64'].compact.join('&')
      response = Net::HTTP.start(uri.host, 443, use_ssl: true, open_timeout: CALL_SECONDS, read_timeout: CALL_SECONDS) { |http| http.get(uri.request_uri, 'User-Agent' => 'dynamic-code-reviews') }
      type = response['Content-Type'].to_s[%r{\Aimage/(png|jpeg|gif|webp)}]
      [type, response.body] if response.is_a?(Net::HTTPSuccess) && type && response.body.bytesize <= AVATAR_BYTES
    end

    # gh: the GitHub CLI executable (DCR_GH lets tests stand one in). avatar: fetches an avatar.
    def initialize(series_dir, gh: ENV.fetch('DCR_GH', 'gh'), avatar: AVATAR)
      @series_dir = series_dir
      @gh = gh
      @avatar = avatar
      @me = nil
      @targets = {}
      @status = {}
      @lock = Mutex.new
    end

    # Whether posting works for this revision, and as whom. Cached for a minute.
    def status(key)
      cached = @lock.synchronize { @status[key] }
      return cached[:value] if cached && Time.now - cached[:at] < STATUS_SECONDS

      value = begin
        target = target(key)
        login = api('GET', 'user')['login']
        pull = api('GET', "repos/#{target[:repo]}/pulls/#{target[:number]}")
        {'ready' => true, 'login' => login, 'repo' => target[:repo], 'number' => target[:number], 'url' => target[:url],
         'author' => pull.dig('user', 'login'), 'state' => pull['merged_at'] ? 'merged' : pull['state'], 'unpushed' => target[:unpushed]}
      rescue Error => error
        {'ready' => false, 'reason' => error.message}
      end
      @lock.synchronize { @status[key] = {at: Time.now, value: value} }
      value
    end

    # Who the GitHub CLI is signed in as, with their avatar as a data: image the page can show
    # under its own rules. Needs no pull request. Kept once found; a failure is asked again after a minute.
    def me
      cached = @lock.synchronize { @me }
      return cached[:value] if cached && (cached[:value]['login'] || Time.now - cached[:at] < STATUS_SECONDS)

      value = begin
        user = api('GET', 'user')
        type, bytes = (@avatar.call(user['avatar_url'].to_s) rescue nil)
        {'login' => user['login'], 'avatar' => type && "data:#{type};base64,#{[bytes].pack('m0')}"}.compact
      rescue Error
        {}
      end
      @lock.synchronize { @me = {at: Time.now, value: value} }
      value
    end

    FETCH_SECONDS = 120

    # The pull request as GitHub has it now: its head and its base branch's tip, both fetched
    # into the repository (no branch or file of the checkout is touched) so they can be compared.
    def pushed(root)
      _, review = saved_page(File.join(@series_dir, 'current.html'))
      match = review&.dig('comparison', 'pr_url').to_s.match(PR_URL) or raise Error, 'This review has no GitHub pull request.'
      slug = "#{match[1]}/#{match[2]}"
      pull = api('GET', "repos/#{slug}/pulls/#{match[3]}")
      head, base = pull.dig('head', 'sha'), pull.dig('base', 'sha')
      raise Error, 'GitHub did not say where the pull request is.' unless head && base
      have = ->(sha) { Open3.capture2e('git', '-C', root, 'cat-file', '-e', "#{sha}^{commit}").last.success? }
      unless have.call(head) && have.call(base)
        remotes, = Open3.capture2('git', '-C', root, 'remote', '-v')
        remote = remotes.lines.find { |line| line.downcase.include?("#{slug.downcase}.git") || line.downcase.match?(/#{Regexp.escape(slug.downcase)}\s/) }&.split&.first || 'origin'
        fetch = ['git', '-C', root, 'fetch', '--quiet', '--no-tags', remote, "refs/pull/#{match[3]}/head", "refs/heads/#{pull.dig('base', 'ref')}"]
        _, status = Timeout.timeout(FETCH_SECONDS) { Open3.capture2e(*fetch) }
        raise Error, 'The pull request could not be fetched from GitHub. Check your connection and try again.' unless status.success? && have.call(head) && have.call(base)
      end
      {'head' => head, 'base' => base, 'number' => match[3].to_i}
    rescue Timeout::Error
      raise Error, 'Fetching the pull request from GitHub took too long. Try again.'
    end

    # One comment, posted now. On lines outside the pull request's diff GitHub refuses a line
    # comment, so it becomes a comment on the file that names the lines.
    def comment(key, item)
      target = target(key)
      item = clean(item, target)
      return issue_comment(target, item) if item['general']

      payload = {'body' => item['body'], 'commit_id' => target[:commit], 'path' => item['path']}
      begin
        raise Unplaceable unless in_diff?(target, item)
        posted = api('POST', "repos/#{target[:repo]}/pulls/#{target[:number]}/comments", payload.merge(placement(item)))
        {'url' => posted['html_url'], 'where' => 'lines'}
      rescue Unplaceable, Rejected
        posted = api('POST', "repos/#{target[:repo]}/pulls/#{target[:number]}/comments",
                     payload.merge('body' => "#{lines_label(item)}\n\n#{item['body']}", 'subject_type' => 'file'))
        {'url' => posted['html_url'], 'where' => 'file'}
      end
    end

    # A review with several comments, as GitHub's Finish your review does. Comments that cannot sit
    # on diff lines go into the review's own text under their file and lines, and say so.
    def review(key, event, body, items)
      raise ArgumentError, "Choose #{EVENTS.join(', ')}" unless EVENTS.include?(event)
      raise ArgumentError, 'Nothing to submit' unless items.is_a?(Array) && !items.empty? && items.length <= 100
      target = target(key)
      items = items.map { |item| clean(item, target) }
      placed, loose = items.partition { |item| !item['general'] && in_diff?(target, item) }
      begin
        posted = post_review(target, event, body, placed, loose)
      rescue Rejected
        placed, loose = [], items # GitHub still refused a line; keep everything, in the text
        posted = post_review(target, event, body, placed, loose)
      end
      urls = review_comment_urls(target, posted['id'], placed)
      result = items.to_h do |item|
        [item['id'], {'url' => urls[item['id']] || posted['html_url'], 'where' => placed.include?(item) ? 'lines' : 'review'}]
      end
      {'url' => posted['html_url'], 'event' => event, 'comments' => result}
    end

    # Takes back a comment this review posted: posted is what was kept of it ({'url', 'where'}).
    # One that is already gone from GitHub counts as taken back. A comment that went into a
    # review's own text has no address of its own and cannot be removed from here.
    def delete(key, posted)
      target = target(key)
      url = posted['url'].to_s
      path = if (id = url[/#discussion_r(\d+)\z/, 1]) then "repos/#{target[:repo]}/pulls/comments/#{id}"
             elsif (id = url[/#issuecomment-(\d+)\z/, 1]) then "repos/#{target[:repo]}/issues/comments/#{id}"
             else raise Error, 'It was posted inside the text of your review, so it has no comment of its own to delete. Edit that review on GitHub.'
             end
      api('DELETE', path)
      {'deleted' => true}
    rescue NotFound
      {'deleted' => true, 'gone' => true}
    end

    private

    Unplaceable = Class.new(StandardError)
    Rejected = Class.new(Error) # 422: usually a line that is not part of the diff
    NotFound = Class.new(Error) # 404

    # The pull request and commit a revision reviewed, from its saved page.
    def target(key)
      number = key.to_s[/:(\d+)\z/, 1] or raise Error, 'Posting needs a saved review revision.'
      @lock.synchronize { @targets[number] } || begin
        snapshot, review = saved(number.to_i)
        raise Error, 'This review revision is not saved.' unless snapshot
        comparison = review['comparison'] || {}
        pr = snapshot['mode'] == 'pr' || review.dig('history', 'origin_mode') == 'pr'
        match = comparison['pr_url'].to_s.match(PR_URL)
        # A revision that shows the reviewer's checkout is posted against the last one that showed
        # the pull request's own head, and only on files whose diff is the same in both.
        pushed = review.dig('history', 'local') ? (number.to_i - 1).downto(1).lazy.filter_map { |earlier| saved(earlier) }.find { |_, was| !was.dig('history', 'local') }&.first : snapshot
        unless pr && match && pushed && comparison['base'] == pushed['base'] && comparison['head'] == pushed['head']
          raise Error, 'This review has no verified GitHub pull request.'
        end
        patches = ->(from) { from['files'].to_h { |file| [file['path'], file['hunks'].map { |hunk| hunk['patch'] }] } }
        same = patches.call(snapshot).select { |path, diff| patches.call(pushed)[path] == diff }.keys
        hunks = snapshot['files'].select { |file| same.include?(file['path']) }.to_h { |file| [file['path'], file['hunks'].map { |hunk| hunk.slice('old_start', 'old_count', 'new_start', 'new_count') }] }
        value = {repo: "#{match[1]}/#{match[2]}", number: match[3].to_i, url: comparison['pr_url'], commit: pushed['head'], hunks: hunks, unpushed: snapshot['files'].map { |file| file['path'] } - same}
        @lock.synchronize { @targets[number] = value }
      end
    end

    # [snapshot, review] of a saved revision, or nil.
    def saved(number) = saved_page(File.join(@series_dir, 'revisions', format('%03d.html', number)))

    def saved_page(path)
      return unless File.file?(path)
      json = File.read(path)[/<script\b(?=[^>]*\bid=["']data["'])[^>]*>(.*?)<\/script>/m, 1] or raise Error, 'This review has no data.'
      JSON.parse(json).values_at('snapshot', 'review')
    end

    def clean(item, target)
      raise ArgumentError, 'Expected a comment' unless item.is_a?(Hash)
      body = item['body'].to_s.strip
      raise ArgumentError, 'A comment cannot be empty' if body.empty?
      raise ArgumentError, 'A comment is limited to 65,000 characters' if body.length > BODY_LIMIT
      id = item['id'].to_s
      raise ArgumentError, 'Invalid comment id' unless id.match?(/\A[\w:.-]{1,200}\z/)
      return {'id' => id, 'body' => body, 'general' => true} if item['general'] == true

      raise ArgumentError, 'This file has changes that are not on the pull request yet. Push them and ask your agent to review the pull request again.' if target[:unpushed].include?(item['path'])
      raise ArgumentError, 'That file is not part of this review' unless target[:hunks].key?(item['path'])
      side = item['side']
      raise ArgumentError, 'Side must be LEFT or RIGHT' unless %w[LEFT RIGHT].include?(side)
      line = Integer(item['line'])
      start = item['start_line'].nil? ? line : Integer(item['start_line'])
      raise ArgumentError, 'Invalid line range' unless start.positive? && line >= start
      {'id' => id, 'body' => body, 'path' => item['path'], 'side' => side, 'line' => line, 'start_line' => start, 'general' => false}
    end

    # Inside one changed section of the reviewed diff, on the commented side.
    def in_diff?(target, item)
      prefix = item['side'] == 'RIGHT' ? 'new' : 'old'
      target[:hunks].fetch(item['path'], []).any? do |hunk|
        first = hunk["#{prefix}_start"].to_i
        last = first + hunk["#{prefix}_count"].to_i - 1
        hunk["#{prefix}_count"].to_i.positive? && item['start_line'] >= first && item['line'] <= last
      end
    end

    def placement(item)
      place = {'line' => item['line'], 'side' => item['side']}
      place.merge!('start_line' => item['start_line'], 'start_side' => item['side']) if item['start_line'] < item['line']
      place
    end

    def lines_label(item)
      side = item['side'] == 'RIGHT' ? 'after' : 'before'
      lines = item['start_line'] == item['line'] ? "line #{item['line']}" : "lines #{item['start_line']}–#{item['line']}"
      "**#{item['path']}**, #{lines} (#{side} the change)"
    end

    def issue_comment(target, item)
      posted = api('POST', "repos/#{target[:repo]}/issues/#{target[:number]}/comments", {'body' => item['body']})
      {'url' => posted['html_url'], 'where' => 'conversation'}
    end

    def post_review(target, event, body, placed, loose)
      intro = body.to_s.strip
      text = [(intro unless intro.empty?), *loose.map { |item| item['general'] ? item['body'] : "#{lines_label(item)}\n\n#{item['body']}" }].compact.join("\n\n---\n\n")
      payload = {'commit_id' => target[:commit], 'event' => event,
                 'comments' => placed.map { |item| placement(item).merge('path' => item['path'], 'body' => item['body']) }}
      payload['body'] = text unless text.empty?
      raise ArgumentError, 'Request changes needs a comment' if event == 'REQUEST_CHANGES' && text.empty? && placed.empty?
      api('POST', "repos/#{target[:repo]}/pulls/#{target[:number]}/reviews", payload)
    end

    # Each posted line comment's own link, matched by file, line and text; the review's link otherwise.
    def review_comment_urls(target, review_id, placed)
      return {} if placed.empty? || !review_id
      remote = api('GET', "repos/#{target[:repo]}/pulls/#{target[:number]}/reviews/#{review_id}/comments?per_page=100")
      placed.to_h do |item|
        found = remote.find { |comment| comment['path'] == item['path'] && comment['body'].to_s.strip == item['body'] && [comment['line'], comment['original_line']].include?(item['line']) }
        [item['id'], found&.dig('html_url')]
      end.compact
    rescue Error
      {}
    end

    # One `gh api` call. Errors become sentences the page can show as they are.
    def api(method, path, payload = nil)
      args = [@gh, 'api', '--method', method, path]
      args += ['--input', '-'] if payload
      out, err, status = run(args, payload && JSON.generate(payload))
      return JSON.parse(out.empty? ? '{}' : out) if status&.success?

      code = err[/HTTP (\d{3})/, 1].to_i
      error = (JSON.parse(out) rescue {})
      reasons = Array(error['errors']).map { |item| item.is_a?(Hash) ? item['message'] : item }.compact.reject(&:empty?)
      detail = reasons.any? ? reasons.join('; ') : error['message']
      raise Rejected, "GitHub refused it: #{detail || 'validation failed'}." if code == 422
      raise Error, 'GitHub CLI is not signed in. Run `gh auth login` in a terminal, then try again.' if code == 401 || err.include?('gh auth login')
      raise NotFound, "GitHub could not find #{path.start_with?('repos/') ? 'the pull request' : 'that'}, or this account cannot see it." if code == 404
      raise Error, "GitHub denied it (#{detail || 'HTTP 403'})." if code == 403
      raise Error, "GitHub returned an error#{code.positive? ? " (HTTP #{code})" : ''}: #{(detail || err.strip.lines.last || 'no details').strip}"
    rescue JSON::ParserError
      raise Error, 'GitHub CLI returned something unreadable.'
    end

    def run(args, input)
      Open3.popen3(*args) do |stdin, stdout, stderr, wait|
        stdin.write(input) if input
        stdin.close
        reader = Thread.new { [stdout.read, stderr.read] }
        unless wait.join(CALL_SECONDS)
          Process.kill('TERM', wait.pid) rescue nil
          raise Error, 'GitHub did not answer in time. Check your connection and try again.'
        end
        out, err = reader.value
        [out, err, wait.value]
      end
    rescue Errno::ENOENT
      raise Error, 'GitHub CLI (`gh`) is not installed. Install it and run `gh auth login`, or use Copy & open on GitHub.'
    end
  end
end
