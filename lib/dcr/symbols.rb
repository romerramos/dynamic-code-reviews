# frozen_string_literal: true

require 'digest'
require 'fileutils'
require 'json'
require 'net/http'
require 'open3'
require 'rbconfig'
require 'tmpdir'
require 'uri'

module DCR
  # Where the names in a review are defined, so the page can link a name to its definition.
  # Universal Ctags reads the whole text a review saved for each file, before and after the change,
  # and knows most languages. Without ctags a review has no links and is otherwise the same.
  #
  # The index the page gets: {name => [[file id, side, line, kind], ...]}.
  module Symbols
    module_function

    ROOT = File.expand_path('../..', __dir__)
    TOOLS = File.join(ROOT, 'tools', 'ctags')

    # One pinned build per platform; `dcr setup` downloads it into tools/ctags.
    # Builds: https://github.com/universal-ctags/ctags-nightly-build and .../ctags-win32 (GPL-2.0).
    NIGHTLY = 'https://github.com/universal-ctags/ctags-nightly-build/releases/download/2026.10.08%2B82494361bb3e7d4f7cf1d2bdc0d0e9001c926e45'
    WIN32 = 'https://github.com/universal-ctags/ctags-win32/releases/download/p6.2.20261011.0'
    BUILDS = {
      'macos-arm64' => ["#{NIGHTLY}/uctags-2026.10.08-macos-11.0-arm64.release.tar.gz", 'cfc0b9d828d56b8114e0c4cb65404f3d5bb19ac95af57b154856f309d23de969'],
      'macos-x86_64' => ["#{NIGHTLY}/uctags-2026.10.08-macos-11.0-x86_64.release.tar.gz", 'bf9c292227ade63268819da88ded41d1efcd97e19c1e4efb1e5baa564d7e61b3'],
      'linux-x86_64' => ["#{NIGHTLY}/uctags-2026.10.08-linux-x86_64.release.tar.gz", '0309295a80caf71d4632badf1e94f696903598c92cc52d1c8fbbc18d03ca38d5'],
      'linux-aarch64' => ["#{NIGHTLY}/uctags-2026.10.08-linux-aarch64.release.tar.gz", '5f7c46041e5e9f15970f95ac35ac907acb9722d2a8ff421f76127698013ed9e2'],
      'windows-x64' => ["#{WIN32}/ctags-p6.2.20261011.0-x64.zip", '2d20e0fb8149e64c6e77d3806a2e56f4d0d0ca5ea20d1b354b26c1d5637a0397']
    }.freeze

    # Prose, data and markup: what ctags finds there are headings and keys, not names code calls.
    SKIPPED = %w[Asciidoc CSS DTD Diff FrontMatter HTML Iniconf JSON JavaProperties Man Markdown OpenAPI Org Passwd
                 PlistXML Pod Quarto RMarkdown ReStructuredText SCSS SVG Scdoc Tex Txt2tags XML Yaml].freeze
    # A name a reader could click: an identifier, with Ruby's ? ! = endings.
    NAME = /\A[A-Za-z_$][\w$]*[?!=]?\z/
    # Templates with code in <script> blocks; ctags reads only those, as TypeScript (which reads JavaScript too).
    SCRIPT_BLOCKS = %w[.svelte .vue].freeze
    CACHE = {}

    def add(payload)
      files = Array(payload.dig('snapshot', 'files')).select { |file| file['source'].is_a?(Hash) }
      index = index(files)
      index ? payload.merge('symbols' => index) : payload
    end

    def index(files)
      exe = ctags
      return nil unless exe
      key = Digest::SHA256.hexdigest(JSON.generate([exe, files.map { |file| [file['id'], file['path'], file['source']] }]))
      CACHE.clear if CACHE.size > 20
      CACHE[key] ||= build(exe, files)
    rescue SystemCallError, IOError, JSON::ParserError
      nil
    end

    def build(exe, files)
      Dir.mktmpdir('dcr-symbols') do |dir|
        places = {}
        files.each_with_index do |file, number|
          path = file['path'].to_s
          next if path.empty? || path.start_with?('/') || path.split('/').include?('..')
          %w[old new].each do |side|
            text = file.dig('source', side).to_s
            next if text.empty?
            name = File.join(number.to_s, side, path)
            if SCRIPT_BLOCKS.include?(File.extname(path).downcase)
              text = script_blocks(text)
              name += '.ts'
            end
            FileUtils.mkdir_p(File.join(dir, File.dirname(name)))
            File.write(File.join(dir, name), text)
            places[name] = [file['id'], side]
          end
        end
        return {} if places.empty?
        out, = Open3.capture3(exe, '--options=NONE', '--map-TypeScript=+.tsx', '--output-format=json', '--fields=+nKl',
                              '-f', '-', '-L', '-', chdir: dir, stdin_data: places.keys.join("\n"))
        tags(out, places)
      end
    end

    # One entry per definition. Where a file still defines a name after the change, its old side's
    # definition of that name is the same one, so only the new is kept.
    def tags(out, places)
      found = out.each_line.filter_map do |line|
        tag = JSON.parse(line)
        place = places[tag['path']]
        next unless tag['_type'] == 'tag' && place && tag['line'] && tag['name'].to_s.match?(NAME) && !SKIPPED.include?(tag['language'])
        [tag['name'], place[0], place[1], tag['line'], tag['kind'].to_s]
      rescue JSON::ParserError
        nil
      end
      kept = found.select { |name, id, side| side == 'new' || found.none? { |other| other[0] == name && other[1] == id && other[2] == 'new' } }
      kept.uniq.sort_by { |name, id, side, line| [name, id, side == 'new' ? 0 : 1, line] }
          .group_by(&:first).transform_values { |entries| entries.map { |entry| entry.drop(1) } }
    end

    # The text with everything outside <script> blocks blanked, so lines and columns stay where they were.
    def script_blocks(text)
      out = text.gsub(/[^\n]/, ' ')
      text.to_enum(:scan, %r{<script\b[^>]*>(.*?)</script>}m).each do
        match = Regexp.last_match
        out[match.begin(1)...match.end(1)] = match[1]
      end
      out
    end

    # A ctags installed on the computer, else the one `dcr setup` downloaded. Only Universal Ctags
    # with JSON output will do; the old BSD ctags macOS ships cannot.
    def ctags
      return @ctags if @ctags
      @ctags = [ENV['DCR_CTAGS'], *%w[ctags universal-ctags uctags].map { |name| which(name) }, *downloaded].compact.find { |path| universal?(path) }
    end

    def downloaded = Dir[File.join(TOOLS, '**', 'ctags{,.exe}')].select { |path| File.file?(path) && File.executable?(path) }.sort

    def which(name)
      exts = Gem.win_platform? ? ENV.fetch('PATHEXT', '.EXE').split(';') : ['']
      ENV.fetch('PATH', '').split(File::PATH_SEPARATOR).each do |dir|
        exts.each do |ext|
          path = File.join(dir, name + ext)
          return path if File.file?(path) && File.executable?(path)
        end
      end
      nil
    end

    def universal?(path)
      return false unless path && File.file?(path)
      version, = Open3.capture2e(path, '--version')
      features, = Open3.capture2e(path, '--list-features')
      version.include?('Universal Ctags') && features.match?(/^json\b/)
    rescue SystemCallError
      false
    end

    def platform
      os = case RbConfig::CONFIG['host_os']
           when /darwin/ then 'macos'
           when /linux/ then 'linux'
           when /mswin|mingw|cygwin/ then 'windows'
           end
      cpu = case RbConfig::CONFIG['host_cpu']
            when /arm64|aarch64/ then os == 'macos' ? 'arm64' : 'aarch64'
            when /x86_64|x64|amd64/ then os == 'windows' ? 'x64' : 'x86_64'
            end
      os && cpu ? "#{os}-#{cpu}" : nil
    end

    # Downloads the pinned build for this computer into tools/ctags, checked against its checksum.
    def setup(out = $stdout)
      if (found = ctags)
        out.puts "Universal Ctags is ready: #{found}"
        return true
      end
      name = platform
      url, sha = BUILDS[name]
      unless url
        out.puts "No ctags build for #{RbConfig::CONFIG['host_os']} #{RbConfig::CONFIG['host_cpu']}. Install Universal Ctags with your package manager; reviews work without it, with no links to definitions."
        return false
      end
      out.puts "Downloading Universal Ctags for #{name}…"
      data = fetch(url)
      actual = Digest::SHA256.hexdigest(data)
      raise "Checksum mismatch for #{url}: expected #{sha}, got #{actual}" unless actual == sha
      FileUtils.rm_rf(TOOLS)
      FileUtils.mkdir_p(TOOLS)
      archive = File.join(TOOLS, File.basename(URI(url).path))
      File.binwrite(archive, data)
      _, status = Open3.capture2e('tar', '-xf', archive, '-C', TOOLS)
      raise "Could not unpack #{archive}" unless status.success?
      File.delete(archive)
      @ctags = nil
      found = ctags
      raise 'The downloaded ctags does not run on this computer' unless found
      out.puts "Universal Ctags is ready: #{found}"
      true
    end

    def fetch(url, redirects = 5)
      uri = URI(url)
      response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', open_timeout: 15, read_timeout: 120) do |http|
        http.request(Net::HTTP::Get.new(uri))
      end
      case response
      when Net::HTTPSuccess then response.body
      when Net::HTTPRedirection
        raise "Too many redirects for #{url}" if redirects.zero?
        fetch(URI.join(url, response['location']).to_s, redirects - 1)
      else raise "Download failed (#{response.code}) for #{url}"
      end
    end
  end
end
