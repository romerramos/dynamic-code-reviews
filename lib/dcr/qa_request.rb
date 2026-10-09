# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'securerandom'
require 'shellwords'
require_relative 'settings'

module DCR
  # Start QA review: the reviewer has shared their tab (cut to the app) and asks the agent to record
  # evidence for the review. The server writes the request, because only it knows the recorder
  # folder, the review's address, the app and the comments, and it fixes the rules the agent follows.
  module QARequest
    module_function

    DCR_BIN = File.expand_path('../../bin/dcr', __dir__)

    # Queues the request in the series state and returns {'id' => <its thread id>}.
    # origin: the review's own address; app: the AppProxy, or nil; route: the app page it shows.
    def call(series_dir:, state:, key:, route:, origin:, app:, capture_dir:)
      require_relative '../../scripts/series'
      manifest = JSON.parse(File.read(File.join(series_dir, 'manifest.json')))
      payload = ReviewSeries.latest(series_dir, ReviewSeries.manifest(series_dir))
      review = payload['review']
      flags = "--repo #{Shellwords.escape(manifest.fetch('repo'))} --name #{Shellwords.escape(manifest.fetch('name'))}"
      dcr = Shellwords.escape(DCR_BIN)
      out = Shellwords.escape(capture_dir)
      paths = Array(payload.dig('snapshot', 'files')).flat_map { |file| Array(file['hunks']).map { |hunk| [hunk['id'], file['path']] } }.to_h
      comments = Array(review['comments']).map do |comment|
        where = paths[comment['hunk']] ? " (#{paths[comment['hunk']]}, lines #{comment['start']}-#{comment['end']})" : ''
        "- #{comment['id']}: #{comment['label']}, #{comment['decoration']}: #{comment['subject']}#{where}"
      end
      # Comments on elements; older ones carry no kind, recordings and QA requests are left out.
      threads = (state.read.dig('threads', key) || {}).select { |id, thread| id.start_with?('app-') && !thread.dig('anchor', 'selector').to_s.empty? && !%w[clip still request].include?(thread.dig('anchor', 'kind')) }
      app_comments = threads.map { |id, thread| "- #{id}: on #{thread.dig('anchor', 'path')}, #{thread.dig('anchor', 'selector')} (\"#{thread.dig('anchor', 'text')}\"): #{thread['messages'].first&.dig('body').to_s.lines.first.to_s.strip}" }
      id = "app-qa-#{SecureRandom.hex(4)}"
      notes = notes_path(manifest.fetch('repo'))
      known = File.file?(notes) ? "Read it first: earlier QA reviews of this repository wrote down what worked." : 'There is none yet; you start it.'
      text = <<~TEXT
        The reviewer pressed Start QA review. Record visual evidence for this review now, in one pass, while they watch.

        Where: the review is open at #{origin}/?app#overview in the reviewer's browser, and its App view shows the running app (#{app ? app.describe[:upstream] : 'no app'}), currently at #{route.to_s.empty? ? '/' : route}. The reviewer already shared that tab with the recorder, cut down to the app, so recording needs no prompt.

        How:
        - Act in that very tab with your browser tool. If it cannot reach the tab (for example Claude in Chrome only reaches tabs in its own group), reply in this thread asking the reviewer to open the review from your tool's tab and press Start QA review there; do not record another tab.
        - Start, stop and snapshot only with the `dcr record` commands below. While they drive the recorder, the review draws your pointer and a ring on each click inside the app, at the coordinates of the input you send, so a tool that never moves the system pointer (DevTools protocol, Playwright, Claude in Chrome) still records a clip a viewer can follow. A computer-use tool that moves the real pointer is shown as it is. Never add a cursor to a recording afterwards.
        - Move to an element before clicking it (hover, then click), at a human pace, so the pointer travels the way a person's would.
        - The app is the large pane in the middle of the App view; act inside it. Change the page with the address field at the top of the App view. Do not close the App view, reload the review or open another tab.
        - For a step that needs the browser's Back or Forward, use the arrows at the left of the App view's address field. They move the app's own history only, never the review's, so such a step can be recorded. Never use the browser's own Back. Each arrow's tooltip names where it leads, and after one is used the status line under the app says where it went, including "the same address" when an entry repeats the one before, which a glance at the page cannot show.
        - Between recordings the App view covers the app with a light veil saying you are preparing, so the reviewer knows nothing is being recorded yet. Clicks pass through it, and it is gone before a recording starts; ignore it.

        Prepare first (not recorded); this is what makes the clips worth watching:
        - QA notes: #{notes} — #{known}
        - Sign in as the right person, without guessing. Find the development accounts the project seeds (its seeds, fixtures or factories, and any notes for agents or developers), then match one to the pages these items touch: their routes and authentication say which kind of user (and which login page) they need. When a login is rejected, look again in those files rather than trying other addresses.
        - Make the data each flow needs to show the change. Look at the pages the items touch: a list to filter needs rows the filter keeps and rows it drops; a state change needs a record in the state before it. When they are missing, create them in the development database only, with the project's own tools (its seeds, factories or console, such as a short runner script) or through the app itself, and keep it to what the flows need.
        - Before you reply, update the QA notes file in a few short lines: which account signs in where, and how you made the data, so the next QA review does not have to find out again. Development seed accounts only; never real credentials or secrets.

        What: record one short clip for each item below whose behaviour a viewer can see. An issue the review only inferred is worth recording most: the clip shows whether it really happens, so record its steps and set the result to failed when it does and passed when it does not. Skip only items about code alone, and say why.
        1. Bring the app to the starting state first; that part is not recorded.
        2. #{dcr} record --out #{out} start --name <item id>
        3. Do the steps at a human pace, about a second per action, and hold one second on the result.
        4. #{dcr} record --out #{out} stop        (prints the saved file's path; `still --name <id>` saves a PNG instead)

        Review comments:
        #{comments.empty? ? '- (none)' : comments.join("\n")}

        Comments on the app:
        #{app_comments.empty? ? '- (none)' : app_comments.join("\n")}

        Also record any changed user flow that has no comment, if seeing it helps.

        Attach everything in one go, which saves one revision the open review offers to the reviewer. This QA review replaces the clips of any previous QA review (the reviewer's own recordings stay), so record every item worth showing now, not only what is new:
        #{dcr} evidence attach #{flags} --file <items.json>
        items.json: [{"path": "<saved file>", "comment_id": "<review comment id, or omit>", "title": "<what the clip shows>", "result": "passed or failed", "observed": "<one sentence on what you saw>", "page": "<app path>"}]
        Use a review comment's id as comment_id so the clip appears on that comment. For a comment on the app, put its id in the title and reply in that thread with what you saw.

        Then reply to this thread: #{dcr} reply #{flags} #{id} '<what you recorded, what you skipped and why, and the data you created>'
      TEXT
      state.request_qa(key, id, text)
      {'id' => id}
    end

    # What QA reviews learned for the next one (who signs in where, how to make data). One file per
    # repository, shared by all its worktrees and kept outside them, so it is never committed.
    def notes_path(repo)
      directory = File.join(File.expand_path(Settings.default_directory), 'qa-notes')
      FileUtils.mkdir_p(directory, mode: 0o700)
      File.join(directory, "#{Settings.repo_key(repo)}.md")
    end
  end
end
