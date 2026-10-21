# frozen_string_literal: true

require 'json'
require 'open3'

module DCR
  # Brings the browser showing a served review to the front, so a reviewer who moved on to other
  # work sees that the review is ready. The agent's browser tool opens the tab but cannot raise the
  # window. `dcr serve` calls this when the review page first loads and `dcr series finish` when the
  # full review is saved; `dcr focus` does it on demand.
  #
  # macOS asks the browser itself, through AppleScript, to select the tab and raise its window.
  # Linux has no way to pick a tab from outside, so it finds the browser window whose title is the
  # review's (the window shows its active tab's title) and asks the window manager to raise it:
  # Hyprland (Omarchy), Sway, or X11 with wmctrl or xdotool.
  module Focus
    module_function

    # Chromium browsers that share Chrome's scripting dictionary, by their process name.
    BROWSERS = ['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Brave Browser', 'Microsoft Edge', 'Arc'].freeze
    # Browser windows on Linux, by their class or app id.
    BROWSER_CLASS = /chrom|brave|edge|vivaldi|opera|firefox|librewolf|zen|floorp/i

    SCRIPT = <<~APPLESCRIPT
      on run argv
        set appName to item 1 of argv
        set prefixes to items 2 thru -1 of argv
        using terms from application "Google Chrome"
          tell application appName
            repeat with w in windows
              set i to 0
              repeat with t in tabs of w
                set i to i + 1
                repeat with prefix in prefixes
                  if (URL of t) starts with (prefix as text) then
                    set active tab index of w to i
                    set index of w to 1
                    activate
                    return "found"
                  end if
                end repeat
              end repeat
            end repeat
          end tell
        end using terms from
        return ""
      end run
    APPLESCRIPT

    # The addresses a served review answers on: this computer (by IP and by name) and the tailnet.
    def prefixes(port, shared = nil)
      ["http://127.0.0.1:#{port}/", "http://localhost:#{port}/", shared && "#{shared.chomp('/')}/"].compact
    end

    # The review's own window title, read from the saved page (the browser adds its name after it).
    def title_of(report)
      title = File.read(report, 4096 * 4, encoding: 'UTF-8')[%r{<title>([^<]+)</title>}, 1]
      title&.gsub('&amp;', '&')&.gsub('&lt;', '<')&.gsub('&gt;', '>')&.gsub('&quot;', '"')&.gsub('&#39;', "'")
    rescue SystemCallError
      nil
    end

    # From a series directory with a running server; returns the browser's name or raises ArgumentError.
    def served(directory, **options)
      endpoint = File.join(directory, '.serve.json')
      raise ArgumentError, 'The review is not being served. Run `dcr serve` first.' unless File.file?(endpoint)
      served = JSON.parse(File.read(endpoint))
      front(prefixes(Integer(served.fetch('port')), served['shared']), title: title_of(File.join(directory, 'current.html')), **options)
    end

    # Returns the browser's name, or raises ArgumentError saying why it could not be raised.
    def front(prefix, title: nil, platform: RUBY_PLATFORM, env: ENV, running: method(:running?), run: method(:osascript), command: method(:command))
      return mac(Array(prefix), running, run) if platform.include?('darwin')
      return linux(title, env, command) if platform.include?('linux')
      raise ArgumentError, 'Bringing the review to the front works on macOS and Linux. Tell the reviewer which tab it is in.'
    end

    def mac(prefixes, running, run)
      browsers = BROWSERS.select { |name| running.call(name) }
      raise ArgumentError, 'No supported browser is running. Tell the reviewer where the review is.' if browsers.empty?
      errors = []
      browsers.each do |name|
        out, error = run.call(name, prefixes)
        return name if out.strip == 'found'
        errors << error.strip unless error.strip.empty?
      end
      if errors.any? { |error| error.include?('-1743') || error.match?(/not authori[sz]ed/i) }
        raise ArgumentError, 'macOS did not allow controlling the browser. Allow it under System Settings > Privacy & Security > Automation, or tell the reviewer which tab the review is in.'
      end
      raise ArgumentError, "No open tab shows #{prefixes.first} in #{browsers.join(', ')}. Open the review in your browser tool first."
    end

    # A window whose title holds the review's title, else any browser window (its review tab may be
    # in the background, and the browser in front is still the best hint).
    def linux(title, env, command)
      raise ArgumentError, 'The review page has no title to look for. Tell the reviewer which tab it is in.' if title.to_s.empty?
      windows = linux_windows(env, command)
      raise ArgumentError, 'This desktop does not let programs raise a window (supported: Hyprland, Sway, X11 with wmctrl or xdotool). Tell the reviewer which tab the review is in.' unless windows
      browsers = windows.select { |window| window[:app].to_s.match?(BROWSER_CLASS) }
      raise ArgumentError, 'No browser window is open. Tell the reviewer where the review is.' if browsers.empty?
      exact = browsers.find { |window| window[:title].to_s.include?(title) }
      target = exact || browsers.first
      _, ok = command.call(*target[:raise])
      raise ArgumentError, 'The window manager refused to raise the browser. Tell the reviewer which tab the review is in.' unless ok
      exact ? target[:app] : raise(ArgumentError, "Raised #{target[:app]}, but the review is not its active tab. Tell the reviewer it is in the tab titled “#{title}”.")
    end

    # [{app:, title:, raise: [command...]}] from the running window manager, or nil when none is supported.
    def linux_windows(env, command)
      if env['HYPRLAND_INSTANCE_SIGNATURE']
        out, ok = command.call('hyprctl', 'clients', '-j')
        return nil unless ok
        JSON.parse(out).map { |c| {app: c['class'], title: c['title'], raise: ['hyprctl', 'dispatch', 'focuswindow', "address:#{c['address']}"]} }
      elsif env['SWAYSOCK']
        out, ok = command.call('swaymsg', '-t', 'get_tree')
        return nil unless ok
        leaves = []
        walk = ->(node) { (node['nodes'].to_a + node['floating_nodes'].to_a).each(&walk); leaves << node if node['pid'] }
        walk.call(JSON.parse(out))
        leaves.map { |n| {app: n['app_id'] || n.dig('window_properties', 'class'), title: n['name'], raise: ['swaymsg', "[con_id=#{n['id']}] focus"]} }
      elsif env['DISPLAY']
        out, ok = command.call('wmctrl', '-lx')
        if ok
          out.lines.filter_map do |line|
            id, _desktop, app, _host, name = line.strip.split(/\s+/, 5)
            {app: app, title: name, raise: ['wmctrl', '-i', '-a', id]} if id
          end
        else
          out, ok = command.call('xdotool', 'search', '--onlyvisible', '--class', 'chrom|brave|firefox|edge|vivaldi')
          return nil unless ok
          out.split.map do |id|
            name, = command.call('xdotool', 'getwindowname', id)
            {app: 'browser', title: name.strip, raise: ['xdotool', 'windowactivate', id]}
          end
        end
      end
    rescue JSON::ParserError
      nil
    end

    def running?(name) = system('pgrep', '-xq', name)

    def osascript(name, prefixes)
      out, error, = Open3.capture3('osascript', '-', name, *prefixes, stdin_data: SCRIPT)
      [out, error]
    end

    # [stdout, success]; a missing program counts as a failure.
    def command(*args)
      out, _err, status = Open3.capture3(*args)
      [out, status.success?]
    rescue SystemCallError
      ['', false]
    end
  end
end
