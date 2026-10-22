# frozen_string_literal: true

require 'json'
require 'open3'

module DCR
  # The first pass of a critical-code review: which files in a repository look like they handle
  # sign-in and users, regulated data, secrets and security, or payments. A cheap search by path
  # and content, so the agent reads a short list, cuts it down and gives each file its reason.
  # It reports which signals matched, never the matched text, so a key in the code is not printed.
  class Critical
    KINDS = {
      'login' => {
        'title' => 'Login and users',
        'path' => %r{(^|[/_.-])(auth\w*|login|logout|sign_?in|sign_?up|sessions_controller|passwords?|oauth|sso|saml|jwt|accounts?|users?|permissions?|roles?|polic(y|ies)|guards?|middleware|devise|clerk|nextauth)([/_.-]|$)}i,
        'signals' => {
          'password hashing' => /bcrypt|argon2|scrypt|pbkdf2|has_secure_password|password_digest|hash_?password/i,
          'tokens' => /jsonwebtoken|\bjwt\b|refresh_?token|access_?token/i,
          'sessions and cookies' => /req\.session|session\[|getServerSession|getSession\(|set-cookie|httpOnly|cookies\(\)/i,
          'auth library' => %r{next-auth|@clerk/|supabase\.auth|firebase/auth|passport\.|devise|lucia|better-auth|auth0|omniauth|django\.contrib\.auth|flask_login}i,
          'access checks' => /current_?user|is_?admin|require_?auth|login_required|authenticate_user|authorize!?|policy_scope|getUser\(/i,
          'sign-in flows' => /sign_?in|reset_?password|forgot_?password|magic_?link|\botp\b|totp|two_?factor|\b2fa\b|verify_?email/i
        }
      },
      'regulated' => {
        'title' => 'Regulated data',
        'path' => %r{(^|[/_.-])(patients?|medical|health|kyc|identity|consent|privacy|gdpr|compliance)([/_.-]|$)}i,
        'signals' => {
          'health' => /diagnos|medical|patient|prescription|symptom|hipaa|health_?record/i,
          'government ids' => /\bssn\b|social_?security|passport|national_?id|tax_?id|driver_?s?_?licen[cs]e/i,
          'birth dates' => /date_?of_?birth|birth_?date|\bdob\b/i,
          'financial accounts' => /\biban\b|account_?number|routing_?number|card_?number|\bcvc\b|\bcvv\b/i,
          'sensitive traits' => /biometric|ethnicity|religion|sexual_?orientation|political_?(view|opinion)/i,
          'children' => /parental_?consent|coppa|age_?verification/i,
          'location' => /geolocation|latitude|longitude/i,
          'privacy rules' => /gdpr|ccpa|data_?retention|personal_?data|\bpii\b|delete_?account|export_?data/i
        }
      },
      'secrets' => {
        'title' => 'Secrets and security',
        'path' => %r{(^|/)(middleware\.\w+|security(\.\w+|/)|cors\.\w+|content_security_policy\.\w+|[\w.-]*\.rules|next\.config\.\w+|vercel\.json|netlify\.toml)$|(^|/)security/|supabase/.*\.sql$}i,
        'signals' => {
          'secret in browser code' => /(NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|REACT_APP_)\w*(SECRET|PRIVATE|SERVICE_ROLE|PASSWORD)/,
          'key written in the code' => /sk_live_[0-9A-Za-z]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|xox[bp]-\d|AIza[0-9A-Za-z_-]{30,}/,
          'secret names' => /(api|secret|private|service_?role)_?key|client_?secret|webhook_?secret|signing_?secret/i,
          'access rules' => /row level security|create policy|security definer|allow (read|write)|rules_version/i,
          'cross-origin and headers' => /Access-Control-Allow-Origin|\bcors\b|helmet|Content-Security-Policy|csrf|xsrf|protect_from_forgery/i,
          'rate limits' => /rate_?limit|throttle|Rack::Attack/i,
          'dangerous calls' => /dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(|child_process|\.html_safe|\$queryRawUnsafe|\$executeRawUnsafe/,
          'encryption and signing' => /createHmac|createCipher|timingSafeEqual|secure_compare|crypto\.subtle|\bencrypt|\bdecrypt/i,
          'file uploads' => /multer|presigned|putObject|createSignedUrl|upload_?file|has_one_attached/i
        }
      },
      'payments' => {
        'title' => 'Payments',
        'path' => %r{(^|[/_.-])(payments?|billing|checkout|stripe|subscriptions?|pricing|invoices?|webhooks?|paywall)([/_.-]|$)}i,
        'signals' => {
          'payment provider' => /stripe|paypal|braintree|adyen|paddle|lemon_?squeezy|razorpay|mollie|revenuecat/i,
          'checkout' => /checkout_?session|payment_?intent|setup_?intent|create_?checkout/i,
          'webhooks' => /constructEvent|Stripe-Signature|verify_?signature|webhook/i,
          'subscriptions and billing' => /subscription|billing|invoice|customer_?portal|billingPortal/i,
          'amounts' => /unit_?amount|price_?id|amount_?cents|refund|payout|coupon|promotion_?code/i
        }
      }
    }.freeze

    # Not where these live: tests, migrations (the current schema says what is stored), docs,
    # assets, lockfiles, vendored and generated code, translations.
    SKIP = [
      %r{(^|/)(test|tests|spec|specs|__tests__|__mocks__|mocks?|fixtures|e2e|cypress|playwright|stories|storybook)(/|$)}i,
      /\.(test|spec|stories)\.[^.]+$/i,
      %r{(^|/)test_[^/]+$|_(test|spec)\.[^./]+$}i,
      %r{(^|/)(migrations?|migrate|seeds?)(/|$)}i,
      %r{(^|/)(vendor|dist|build|out|public|node_modules|\.next|coverage|locales?|i18n|translations|generated|__generated__|docs?|examples?|\.reviews)(/|$)}i,
      /\.(md|mdx|txt|rst|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|css|scss|sass|less|map|snap|csv|pdf|mp3|mp4|webm|zip|gz)$/i,
      /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile\.lock|poetry\.lock|Cargo\.lock|composer\.lock|go\.sum)$/,
      /\.(min\.js|d\.ts|generated\.\w+)$/,
      %r{(^|/)(\.github/|CODEOWNERS$|\.rubocop[\w.-]*\.yml$|\.eslintrc[\w.]*$|\.prettierrc[\w.]*$)}
    ].freeze
    MAX_BYTES = 300_000
    SHOWN = 40

    def initialize(root)
      @root = root
    end

    # Every candidate, most critical first: {path, lines, score, kinds: {kind => [signals]}}.
    # A kind matched by the path counts the path as a signal ("path").
    def candidates
      files.filter_map do |path|
        text = read(path)
        next unless text
        kinds = KINDS.to_h do |kind, rule|
          signals = rule['signals'].select { |_, pattern| text.match?(pattern) }.keys
          signals.unshift('path') if path.match?(rule['path'])
          [kind, signals]
        end.reject { |_, signals| signals.empty? }
        score = kinds.values.sum { |signals| signals.sum { |signal| signal == 'path' ? 2 : 1 } }
        {'path' => path, 'lines' => text.count("\n"), 'score' => score, 'kinds' => kinds} if score >= 2
      end.sort_by { |file| [-file['score'], file['path']] }
    end

    def files
      output, status = Open3.capture2('git', '-C', @root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
      raise ArgumentError, 'Not a git checkout' unless status.success?
      output.split("\0").uniq.reject { |path| SKIP.any? { |pattern| path.match?(pattern) } || DynamicReviews.sensitive?(path) }
    end

    def read(path)
      target = File.join(@root, path)
      return if File.symlink?(target) || !File.file?(target) || File.size(target) > MAX_BYTES
      data = File.binread(target)
      DynamicReviews.text(data) unless data.include?("\0")
    end

    # What the agent reads first: totals per kind and the strongest candidates, one line each.
    def self.brief(found, out)
      kinds = KINDS.map { |kind, rule| "#{rule['title']}: #{found.count { |file| file['kinds'].key?(kind) }}" }
      lines = found.first(SHOWN).map do |file|
        "#{file['score'].to_s.rjust(3)}  #{file['path']} (#{file['lines']} lines)  #{file['kinds'].map { |kind, signals| "#{kind}: #{signals.join(', ')}" }.join(' · ')}"
      end
      more = found.length > SHOWN ? ["… #{found.length - SHOWN} more in #{out}"] : []
      ["#{found.length} candidate files (#{kinds.join(', ')}); all of them in #{out}", *lines, *more].join("\n")
    end
  end
end
