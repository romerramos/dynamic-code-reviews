# frozen_string_literal: true

require 'json'
require 'open3'

module DCR
  # Shares a served review on the reviewer's tailnet with Tailscale Serve, so it can be opened from
  # another device (a phone, a laptop in a remote session) at https://<machine>.<tailnet>.ts.net:<port>.
  # Tailscale is the only dependency: no other proxy, and nothing about the reviewed app's own setup.
  # Serve stays inside the tailnet (never Funnel) and tells the server who is asking: it sets
  # Tailscale-User-Login on every request it forwards, replacing any value the visitor sent, so the
  # review only answers the people it is shared with.
  module Share
    module_function

    # {'ok' => true, 'host' => name, 'login' => owner} or {'ok' => false, 'reason' => why not}.
    def check(run: method(:tailscale))
      out, status = run.call('status', '--json')
      return {'ok' => false, 'reason' => 'Tailscale is not installed'} if status.nil?
      return {'ok' => false, 'reason' => 'Tailscale is not running here'} unless status
      data = JSON.parse(out)
      return {'ok' => false, 'reason' => "Tailscale is #{data['BackendState'].to_s.downcase} on this computer"} unless data['BackendState'] == 'Running'
      host = data.dig('Self', 'DNSName').to_s.chomp('.')
      return {'ok' => false, 'reason' => 'MagicDNS is off on this tailnet, so there is no name to share at'} if host.empty?
      unless Array(data['CertDomains']).include?(host)
        return {'ok' => false, 'reason' => 'HTTPS certificates are off on this tailnet (turn them on under DNS in the Tailscale admin console)'}
      end
      login = data.dig('User', data.dig('Self', 'UserID').to_s, 'LoginName').to_s
      {'ok' => true, 'host' => host, 'login' => login}
    rescue JSON::ParserError
      {'ok' => false, 'reason' => 'Tailscale gave an unreadable status'}
    end

    # Serves 127.0.0.1:<port> at https://<host>:<port> on the tailnet. Returns that origin.
    def expose(port, host, run: method(:tailscale))
      out, status = run.call('serve', '--bg', "--https=#{Integer(port)}", "http://127.0.0.1:#{Integer(port)}")
      raise ArgumentError, "Tailscale could not share port #{port}: #{out.strip.lines.last}" unless status
      "https://#{host}:#{Integer(port)}"
    end

    def withdraw(port, run: method(:tailscale))
      run.call('serve', "--https=#{Integer(port)}", 'off')
    end

    # [output, success]; success is nil when the CLI is missing.
    def tailscale(*args)
      out, err, status = Open3.capture3('tailscale', *args)
      ["#{out}#{err}", status.success?]
    rescue Errno::ENOENT
      ['', nil]
    end
  end
end
