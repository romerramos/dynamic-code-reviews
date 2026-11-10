# frozen_string_literal: true

# A made-up review for visual QA (scripts/qa_visual.js): a small invented app, a change to it, and
# a review with every kind of thing a page draws. Agent comments of several types, your own on a
# file and a general one, one carried from an earlier revision, resolved ones, conversations with
# answers from several agents (with a table and a code block), an adversary that did not answer,
# QA recordings and a risk ranking. Nobody in it is real.
#
#   ruby scripts/qa_fixture.rb <directory>
#
# Writes <directory>/repo (the invented checkout, its series under .reviews/qa-fixture) and prints
# JSON: the report path, the storage key and the progress the page reads from browser storage.
require 'fileutils'
require 'json'
require 'open3'
require 'zlib'
require 'tmpdir'
ENV['DCR_CONFIG_DIR'] ||= Dir.mktmpdir('dcr-config') # never read or write the reviewer's own settings; qa_visual.js passes its own
require_relative 'review'
require_relative 'series'
require_relative '../lib/dcr/state'
require_relative '../lib/dcr/settings'

module QAFixture
  module_function

  BASE = {
    'app/models/booking.rb' => <<~RUBY,
      class Booking < ApplicationRecord
        belongs_to :boat
        belongs_to :guest

        validates :starts_on, :ends_on, presence: true

        def nights
          (ends_on - starts_on).to_i
        end

        def total
          boat.nightly_rate * nights
        end
      end
    RUBY
    'app/controllers/bookings_controller.rb' => <<~RUBY,
      class BookingsController < ApplicationController
        def index
          @bookings = current_guest.bookings.order(:starts_on)
        end

        def destroy
          booking = current_guest.bookings.find(params[:id])
          booking.destroy
          redirect_to bookings_path, notice: "Booking cancelled"
        end
      end
    RUBY
    'app/views/bookings/index.html.erb' => <<~ERB,
      <h1>Your bookings</h1>
      <ul class="bookings">
        <% @bookings.each do |booking| %>
          <li><%= booking.boat.name %>, <%= booking.nights %> nights</li>
        <% end %>
      </ul>
    ERB
    'test/models/booking_test.rb' => <<~RUBY,
      require "test_helper"

      class BookingTest < ActiveSupport::TestCase
        test "counts the nights" do
          booking = bookings(:weekend)
          assert_equal 2, booking.nights
        end
      end
    RUBY
    'config/routes.rb' => <<~RUBY
      Rails.application.routes.draw do
        resources :bookings, only: %i[index destroy]
      end
    RUBY
  }.freeze

  CHANGED = {
    'app/models/booking.rb' => <<~RUBY,
      class Booking < ApplicationRecord
        FREE_CANCELLATION = 48.hours
        FEE_RATE = 0.15

        belongs_to :boat
        belongs_to :guest
        has_many :refunds, dependent: :destroy

        validates :starts_on, :ends_on, presence: true

        def nights
          (ends_on - starts_on).to_i
        end

        def total
          boat.nightly_rate * nights
        end

        def cancellation_fee(at: Time.current)
          return 0 if starts_on.to_time - at > FREE_CANCELLATION
          (total * FEE_RATE).round(2)
        end

        def cancel!(at: Time.current)
          transaction do
            refunds.create!(amount: total - cancellation_fee(at: at))
            update!(cancelled_at: at)
          end
        end
      end
    RUBY
    'app/controllers/bookings_controller.rb' => <<~RUBY,
      class BookingsController < ApplicationController
        def index
          @bookings = current_guest.bookings.where(cancelled_at: nil).order(:starts_on)
        end

        def destroy
          booking = current_guest.bookings.find(params[:id])
          booking.cancel!
          redirect_to bookings_path, notice: "Booking cancelled. Your refund is on its way."
        end
      end
    RUBY
    'app/views/bookings/index.html.erb' => <<~ERB,
      <h1>Your bookings</h1>
      <ul class="bookings">
        <% @bookings.each do |booking| %>
          <li>
            <%= booking.boat.name %>, <%= booking.nights %> nights
            <% if booking.cancellation_fee.positive? %>
              <small>Cancelling now costs <%= number_to_currency(booking.cancellation_fee) %></small>
            <% end %>
            <%= button_to "Cancel", booking_path(booking), method: :delete %>
          </li>
        <% end %>
      </ul>
    ERB
    'test/models/booking_test.rb' => <<~RUBY,
      require "test_helper"

      class BookingTest < ActiveSupport::TestCase
        test "counts the nights" do
          booking = bookings(:weekend)
          assert_equal 2, booking.nights
        end

        test "cancelling early is free" do
          booking = bookings(:weekend)
          assert_equal 0, booking.cancellation_fee(at: booking.starts_on - 3.days)
        end

        test "cancelling late costs fifteen percent" do
          booking = bookings(:weekend)
          assert_equal 45.0, booking.cancellation_fee(at: booking.starts_on - 1.day)
        end
      end
    RUBY
    'config/routes.rb' => <<~RUBY
      Rails.application.routes.draw do
        resources :bookings, only: %i[index destroy] do
          resources :refunds, only: :index
        end
      end
    RUBY
  }.freeze

  def sh(dir, *command)
    out, status = Open3.capture2e(*command, chdir: dir)
    raise "#{command.join(' ')} failed: #{out}" unless status.success?
    out
  end

  # A flat PNG, so the QA flows carry real images without any file of ours.
  def png(width, height, rgb)
    row = "\x00".b + rgb.pack('C3') * width
    data = Zlib::Deflate.deflate(row * height)
    chunk = ->(type, body) { [body.bytesize].pack('N') + type + body + [Zlib.crc32(type + body)].pack('N') }
    "\x89PNG\r\n\x1a\n".b + chunk.call('IHDR', [width, height, 8, 2, 0, 0, 0].pack('NNCCCCC')) + chunk.call('IDAT', data) + chunk.call('IEND', '')
  end

  def data_uri(bytes) = "data:image/png;base64,#{[bytes].pack('m0')}"

  def line_of(text, needle) = text.lines.index { |line| line.include?(needle) } + 1

  def build(directory)
    repo = File.join(directory, 'repo')
    FileUtils.rm_rf(repo)
    FileUtils.mkdir_p(repo)
    sh(repo, 'git', 'init', '-q', '-b', 'main')
    sh(repo, 'git', 'config', 'user.name', 'Fixture Author')
    sh(repo, 'git', 'config', 'user.email', 'fixture@example.com')
    BASE.each { |path, text| FileUtils.mkdir_p(File.dirname(File.join(repo, path))); File.write(File.join(repo, path), text) }
    sh(repo, 'git', 'add', '.')
    sh(repo, 'git', 'commit', '-q', '-m', 'Bookings')
    CHANGED.each { |path, text| File.write(File.join(repo, path), text) }

    snapshot = DynamicReviews.collect(repo: repo, mode: 'uncommitted')
    files = snapshot['files'].to_h { |file| [file['path'], file] }
    id = ->(path) { files.fetch(path)['id'] }
    # The range holding a line of the changed file (the first range when no line is given).
    hunk = lambda do |path, line = nil|
      ranges = files.fetch(path)['hunks']
      found = line && ranges.find { |h| DynamicReviews.diff_rows(h)['unified'].any? { |row| row['new'] == line } }
      (found || ranges.first)['id']
    end
    summaries = ->(path) { files.fetch(path)['hunks'].to_h { |h| [h['id'], "What this range of #{File.basename(path)} does for cancelling a booking."] } }
    model = CHANGED['app/models/booking.rb']
    controller = CHANGED['app/controllers/bookings_controller.rb']
    view = CHANGED['app/views/bookings/index.html.erb']
    routes = CHANGED['config/routes.rb']
    fee = line_of(model, 'def cancellation_fee')
    rounding = line_of(model, '.round(2)')
    refund = line_of(model, 'refunds.create!')

    comments = [
      {'id' => 'fee-window', 'label' => 'question', 'decoration' => 'non-blocking', 'agent' => 'claude', 'model' => 'claude-opus-5-5', 'effort' => 'high',
       'subject' => 'Does the free window count from check-in time or from midnight?',
       'discussion' => "`starts_on` is a date, so `starts_on.to_time` is midnight in the server's zone.\n\nA guest checking in at 3pm loses fifteen hours of the free window.",
       'hunk' => hunk.call('app/models/booking.rb', fee), 'side' => 'new', 'start' => fee, 'end' => fee + 1},
      {'id' => 'refund-twice', 'label' => 'issue', 'decoration' => 'blocking', 'agent' => 'grok', 'model' => 'grok-4.7',
       'subject' => 'Cancelling twice refunds the guest twice',
       'discussion' => "Nothing stops `cancel!` on a booking that is already cancelled.\n\n1. Open Your bookings.\n2. Press Cancel twice quickly.\n\nExpected: one refund.\nActual: two refunds.",
       'hunk' => hunk.call('app/models/booking.rb', refund - 1), 'side' => 'new', 'start' => refund - 1, 'end' => refund + 1},
      {'id' => 'fee-rounding', 'label' => 'nitpick', 'decoration' => 'non-blocking', 'agent' => 'codex', 'model' => 'gpt-6.1-sol',
       'subject' => 'Round the fee with the currency, not with two decimals',
       'discussion' => 'Yen has no decimals; `round(2)` leaves a fraction the view then rounds again.',
       'hunk' => hunk.call('app/models/booking.rb', rounding), 'side' => 'new', 'start' => rounding, 'end' => rounding},
      {'id' => 'refund-route', 'label' => 'chore', 'decoration' => 'non-blocking', 'agent' => 'claude',
       'subject' => 'The refunds route has no controller yet',
       'discussion' => 'Drop the nested route until the controller lands, or the route list shows a dead end.',
       'hunk' => hunk.call('config/routes.rb'), 'side' => 'new', 'start' => line_of(routes, 'resources :refunds'), 'end' => line_of(routes, 'resources :refunds')},
      {'id' => 'notice-copy', 'label' => 'suggestion', 'decoration' => 'non-blocking', 'agent' => 'codex',
       'subject' => 'Say how much is refunded in the notice',
       'discussion' => 'The guest sees the fee before cancelling but not the refund after.',
       'hunk' => hunk.call('app/controllers/bookings_controller.rb'), 'side' => 'new', 'start' => line_of(controller, 'redirect_to'), 'end' => line_of(controller, 'redirect_to')},
      {'id' => 'fee-label', 'label' => 'praise', 'decoration' => 'non-blocking', 'agent' => 'claude',
       'subject' => 'The fee is shown before the guest presses Cancel',
       'discussion' => 'Good: nobody is surprised by the charge.',
       'hunk' => hunk.call('app/views/bookings/index.html.erb'), 'side' => 'new', 'start' => line_of(view, 'Cancelling now costs'), 'end' => line_of(view, 'Cancelling now costs')},
      {'id' => 'old-destroy', 'label' => 'issue', 'decoration' => 'blocking', 'agent' => 'claude',
       'subject' => 'Destroying the booking loses its payment history',
       'discussion' => 'An earlier revision deleted the row outright.',
       'general' => true, 'outdated' => {'path' => 'app/controllers/bookings_controller.rb', 'side' => 'new', 'start' => 8, 'end' => 8, 'lines' => ['    booking.destroy'], 'revision' => 1}}
    ]

    qa_flows = [
      {'title' => 'Cancel a booking inside the free window', 'steps' => ['Open Your bookings', 'Press Cancel on the weekend trip'],
       'expected' => 'No fee, a full refund', 'observed' => 'No fee, a full refund', 'result' => 'passed',
       'assets' => [{'caption' => 'The booking list after cancelling', 'data_uri' => data_uri(png(320, 200, [214, 228, 240]))}]},
      {'title' => 'Cancel the same booking twice', 'steps' => ['Open Your bookings', 'Press Cancel twice quickly'],
       'expected' => 'One refund', 'observed' => 'Two refunds were created', 'result' => 'failed', 'comment_id' => 'refund-twice',
       'assets' => [{'caption' => 'Two refunds for one booking', 'data_uri' => data_uri(png(320, 200, [240, 214, 214])), 'comment_id' => 'refund-twice'}]}
    ]

    review = {
      'title' => 'Charge a fee for late cancellations',
      'summary' => "Cancelling a booking inside 48 hours of check-in now costs 15% of its total, and the rest is refunded.\n\nThe booking list shows the fee before the guest presses Cancel, and cancelled bookings leave the list.",
      'effort' => {'score' => 2, 'reason' => 'One model method carries the rule; the rest shows it.'},
      'coverage' => 'All 5 files read.', 'validation' => ['Tests: not run, made-up fixture'],
      'groups' => [
        {'title' => 'The fee and the refund', 'summary' => 'Where the fee is worked out and the refund made.',
         'layers' => [
           {'title' => 'Work out the fee', 'summary' => 'The rule itself.', 'items' => [{'file' => id.call('app/models/booking.rb'), 'summaries' => summaries.call('app/models/booking.rb')}]},
           {'title' => 'Cancel from the list', 'summary' => 'The page and the route.',
            'items' => [{'file' => id.call('app/controllers/bookings_controller.rb'), 'summaries' => summaries.call('app/controllers/bookings_controller.rb')},
                        {'file' => id.call('app/views/bookings/index.html.erb'), 'summaries' => summaries.call('app/views/bookings/index.html.erb')},
                        {'file' => id.call('config/routes.rb'), 'summaries' => summaries.call('config/routes.rb')}]}
         ]},
        {'title' => 'Tests', 'summary' => 'The two new cases.',
         'layers' => [{'title' => 'The fee in tests', 'summary' => 'Early and late.', 'items' => [{'file' => id.call('test/models/booking_test.rb'), 'summaries' => summaries.call('test/models/booking_test.rb')}]}]}
      ],
      'risk_ranking' => {'summary' => 'The money moves in one method.', 'files' => [
        {'file' => id.call('app/models/booking.rb'), 'score' => 82, 'tags' => %w[money], 'reason' => 'Creates the refund; nothing stops it running twice for one booking.', 'title' => 'A booking can be refunded twice', 'line' => refund},
        {'file' => id.call('app/controllers/bookings_controller.rb'), 'score' => 48, 'tags' => %w[user-facing], 'reason' => 'Cancels on every delete request, with no confirmation step.', 'title' => 'Cancel runs on one click'}
      ]},
      'findings' => [], 'sections' => [], 'comments' => comments,
      'qa' => {'status' => 'complete', 'fingerprint' => snapshot['fingerprint'], 'summary' => 'Two cancellation flows recorded.', 'environment' => 'Made-up fixture app', 'flows' => qa_flows}
    }

    work = File.join(directory, 'work')
    FileUtils.mkdir_p(work)
    File.write(File.join(work, 'snapshot.json'), JSON.generate(snapshot))
    File.write(File.join(work, 'review.json'), JSON.generate(review))
    out, status = Open3.capture2e(RbConfig.ruby, File.expand_path('series.rb', __dir__), 'start', '--repo', repo, '--name', 'qa-fixture',
                                  '--snapshot', File.join(work, 'snapshot.json'), '--review', File.join(work, 'review.json'))
    raise "series start failed: #{out}" unless status.success?
    series = File.join(repo, '.reviews', 'qa-fixture')
    report = File.join(series, 'current.html')
    payload = DCR::Page.payload(File.read(report))
    history = payload['review']['history']
    key = "dynamic-review:#{payload['snapshot']['fingerprint']}:#{history['series']}:#{history['revision']}"

    # What the reader did in the browser: two comments of their own, one resolved, and a question for the agent.
    personal = [
      {'id' => 'mine-file-note', 'hunk' => hunk.call('app/views/bookings/index.html.erb'), 'side' => 'new', 'start' => line_of(view, 'button_to'), 'end' => line_of(view, 'button_to'),
       'at' => '2026-11-09T10:12:00Z', 'label' => 'thought', 'decoration' => 'non-blocking', 'audience' => 'pr',
       'subject' => 'Ask before cancelling: one stray click costs the guest money', 'discussion' => 'A confirm step would also stop the double refund.'},
      {'id' => 'mine-general-ask', 'general' => true, 'at' => '2026-11-09T10:20:00Z', 'label' => 'question', 'decoration' => 'non-blocking', 'audience' => 'agent',
       'subject' => 'Which bookings already started would this charge?', 'discussion' => ''},
      {'id' => 'mine-done', 'hunk' => hunk.call('test/models/booking_test.rb'), 'side' => 'new', 'start' => line_of(CHANGED['test/models/booking_test.rb'], 'cancelling late'), 'end' => line_of(CHANGED['test/models/booking_test.rb'], 'cancelling late'),
       'at' => '2026-11-09T10:25:00Z', 'label' => 'nitpick', 'decoration' => 'non-blocking', 'audience' => 'pr',
       'subject' => 'Name the test after the rule, not the number', 'discussion' => ''}
    ]
    progress = {'personalComments' => personal, 'resolvedComments' => %w[notice-copy fee-label mine-done], 'notes' => {}, 'fileOpen' => {}, 'groupOpen' => {}, 'componentFiles' => {}}

    state = DCR::State.new(series)
    state.save_blob(key, progress)
    # Titled already, so the page never asks an agent CLI to name them.
    {'mine-file-note' => 'Ask before cancelling to stop double refunds', 'mine-general-ask' => 'Which started bookings would this charge?',
     'mine-done' => 'Name the test after the rule'}.each { |id, title| state.set_title(key, id, title) }
    table = <<~MD.strip
      It counts from midnight. Here is what a guest checking in at 3pm sees:

      | Cancelled at | Hours before check-in | Fee |
      | --- | --- | --- |
      | Thursday 9am | 54 | none |
      | Thursday 6pm | 45 | 15% |
      | Friday 9am | 30 | 15% |

      The second row is the one that surprises: by the guest's clock they are still inside the window.
    MD
    code = <<~MD.strip
      Store the check-in time with the boat and count from it:

      ```ruby
      def check_in_at
        starts_on.in_time_zone(boat.time_zone).change(hour: boat.check_in_hour)
      end

      def cancellation_fee(at: Time.current)
        return 0 if check_in_at - at > FREE_CANCELLATION
        (total * FEE_RATE).round(2)
      end
      ```
    MD
    state.send_items(key, [{'id' => 'fee-window', 'text' => 'Does it count from midnight?', 'message' => 'Does this count from midnight or from the check-in time?'}])
    state.agent_reply('fee-window', table, key: key, agent: 'claude', model: 'claude-opus-5-5', effort: 'high')
    state.user_message(key, 'fee-window', 'What would you change?')
    state.agent_reply('fee-window', code, key: key, agent: 'claude', model: 'claude-opus-5-5', effort: 'high')
    state.await_opinions(key, 'fee-window', 'codex', %w[grok gemini])
    state.add_opinion(key, 'fee-window', 'codex', 'Agreed: the boat already has a time zone, so the fix is small.', verdict: 'agree', adversary: true, model: 'gpt-6.1-sol')
    state.add_opinion(key, 'fee-window', 'grok', 'Partly: the check-in hour varies by marina, not by boat.', verdict: 'partly', short: 'The check-in hour belongs to the marina.', model: 'grok-4.7')
    state.opinion_failed(key, 'fee-window', 'gemini', 'Gemini did not answer within 5 minutes.')

    state.send_items(key, [{'id' => 'refund-twice', 'text' => 'Is a lock enough here?', 'message' => 'Is a row lock enough here, or do we need a unique index?'}])
    state.agent_reply('refund-twice', "A lock on the booking is enough for one server:\n\n```ruby\nwith_lock do\n  return if cancelled_at\n  refunds.create!(amount: total - cancellation_fee(at: at))\n  update!(cancelled_at: at)\nend\n```", key: key, agent: 'grok', model: 'grok-4.7')

    state.send_items(key, [{'id' => 'mine-general-ask', 'text' => 'Which bookings already started would this charge?'}])
    state.agent_reply('mine-general-ask', 'None: a booking that has started has no Cancel button, and `cancel!` is only reached from it.', key: key, agent: 'codex', model: 'gpt-6.1-sol', title: 'Started bookings and the fee')

    # The reader chose their adversaries already, and keeps this made-up code away from JevMyPR.
    settings = DCR::Settings.new
    settings.save_adversaries([{'agent' => 'codex'}, {'agent' => 'grok'}, {'agent' => 'gemini'}])
    settings.save_jevmypr(repo, false)
    state.heartbeat('claude', 'claude-opus-5-5', 'high')

    {'report' => report, 'series' => series, 'repo' => repo, 'key' => key, 'progress' => progress}
  end
end

puts JSON.generate(QAFixture.build(File.expand_path(ARGV.fetch(0)))) if $PROGRAM_NAME == __FILE__
