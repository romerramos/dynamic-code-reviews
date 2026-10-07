# frozen_string_literal: true

require 'open3'

module DCR
  # Brings the browser tab that shows a served review to the front, so a reviewer who moved on to
  # other work sees that the review is ready. The agent's browser tool opens the tab but cannot raise
  # the window, so on macOS this asks the browser itself, through AppleScript. Only browsers that are
  # running are addressed: naming one that is not installed would make macOS ask where it is.
  module Focus
    module_function

    # Chromium browsers that share Chrome's scripting dictionary, by their process name.
    BROWSERS = ['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Brave Browser', 'Microsoft Edge', 'Arc'].freeze

    SCRIPT = <<~APPLESCRIPT
      on run argv
        set appName to item 1 of argv
        set prefix to item 2 of argv
        using terms from application "Google Chrome"
          tell application appName
            repeat with w in windows
              set i to 0
              repeat with t in tabs of w
                set i to i + 1
                if (URL of t) starts with prefix then
                  set active tab index of w to i
                  set index of w to 1
                  activate
                  return "found"
                end if
              end repeat
            end repeat
          end tell
        end using terms from
        return ""
      end run
    APPLESCRIPT

    # Returns the browser's name, or raises ArgumentError saying why the tab could not be raised.
    def front(prefix, running: method(:running?), run: method(:osascript))
      raise ArgumentError, 'Bringing the review to the front works on macOS only. Tell the reviewer which tab it is in.' unless RUBY_PLATFORM.include?('darwin')
      browsers = BROWSERS.select { |name| running.call(name) }
      raise ArgumentError, 'No supported browser is running. Tell the reviewer where the review is.' if browsers.empty?
      errors = []
      browsers.each do |name|
        out, error = run.call(name, prefix)
        return name if out.strip == 'found'
        errors << error.strip unless error.strip.empty?
      end
      if errors.any? { |error| error.include?('-1743') || error.match?(/not authori[sz]ed/i) }
        raise ArgumentError, 'macOS did not allow controlling the browser. Allow it under System Settings > Privacy & Security > Automation, or tell the reviewer which tab the review is in.'
      end
      raise ArgumentError, "No open tab shows #{prefix} in #{browsers.join(', ')}. Open the review in your browser tool first."
    end

    def running?(name) = system('pgrep', '-xq', name)

    def osascript(name, prefix)
      out, error, = Open3.capture3('osascript', '-', name, prefix, stdin_data: SCRIPT)
      [out, error]
    end
  end
end
