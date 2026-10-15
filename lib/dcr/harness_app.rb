# frozen_string_literal: true

module DCR
  # The running app a coding harness already knows for the checkout, so `dcr serve` shows it even
  # when the agent did not find it. Conductor runs the agent inside the workspace with
  # CONDUCTOR_WORKSPACE_PATH set, and the repository declares the app as a preview URL in
  # `.conductor/settings.local.toml` or `.conductor/settings.toml`, in the workspace or the repository
  # root, like `url = "https://app.$CONDUCTOR_WORKSPACE_NAME.test"`.
  module HarnessApp
    module_function

    SETTINGS = %w[.conductor/settings.local.toml .conductor/settings.toml].freeze

    # [url, where it came from], or nil. Only for the checkout the harness runs in.
    def find(repo, env = ENV)
      workspace = env['CONDUCTOR_WORKSPACE_PATH']
      return unless workspace && same_path?(workspace, repo)

      [repo, env['CONDUCTOR_ROOT_PATH']].compact.uniq.each do |dir|
        SETTINGS.each do |name|
          path = File.join(dir, name)
          next unless File.file?(path)
          url = preview(File.read(path), env)
          return [url, "Conductor's preview URL in #{path}"] if url
        end
      end
      nil
    end

    # The preview named App, else the first one, with its $VARIABLES filled in from the environment.
    # One that names a variable the environment lacks is skipped.
    def preview(toml, env)
      previews = toml.split(/^\s*\[\[preview_urls\]\]\s*$/).drop(1).map do |block|
        block = block.split(/^\s*\[/, 2).first
        {name: block[/^\s*name\s*=\s*"([^"]*)"/, 1].to_s, url: block[/^\s*url\s*=\s*"([^"]*)"/, 1]}
      end
      previews = previews.select { |item| item[:url] }.filter_map do |item|
        missing = false
        url = item[:url].gsub(/\$\{?([A-Z_][A-Z0-9_]*)\}?/) { env[$1] || (missing = true; '') }
        item.merge(url: url) unless missing
      end
      (previews.find { |item| item[:name].casecmp?('app') } || previews.first)&.fetch(:url)
    end

    def same_path?(a, b)
      File.realpath(a) == File.realpath(b)
    rescue SystemCallError
      false
    end
  end
end
