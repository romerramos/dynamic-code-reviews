#!/usr/bin/env ruby
# frozen_string_literal: true

# A critical-code review of a repository: the candidates, the chosen files and their updates.
ENV['DCR_FOCUS'] = '0'
require_relative 'test_review'
require_relative 'series'
require_relative '../lib/dcr/critical'

module CriticalChecks
  module_function

  def assert(value, message) = ReviewChecks.assert(value, message)
  def rejects(message, &block) = ReviewChecks.rejects(message, &block)

  # A small app: sign-in, a payment webhook, a profile with a birth date, a key shipped to the
  # browser, and the files a critical review leaves out (a button, a test, a migration).
  APP = {
    'app/api/auth/login/route.ts' => "import bcrypt from 'bcryptjs'\nexport async function POST(req) {\n  const ok = await bcrypt.compare(req.password, user.passwordHash)\n  return signIn(user)\n}\n",
    'app/api/stripe/webhook/route.ts' => "import Stripe from 'stripe'\nexport async function POST(req) {\n  const event = JSON.parse(await req.text())\n  if (event.type === 'checkout.session.completed') await markPaid(event)\n}\n",
    'app/profile/save.ts' => "export function save(form) {\n  return db.profile.update({ dateOfBirth: form.date_of_birth, passport: form.passport })\n}\n",
    'lib/supabase.ts' => "export const admin = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY)\nconst fallback = '#{'sk_live_' + 'Z9' * 12}'\n",
    'components/Button.tsx' => "export function Button({ children }) {\n  return <button>{children}</button>\n}\n",
    'app/api/auth/login/route.test.ts' => "import bcrypt from 'bcryptjs'\ntest('signs in', () => signIn(user))\n",
    'db/migrations/001_users.sql' => "create table users (password_hash text, date_of_birth date);\n",
    'README.md' => "Stripe checkout and sign in with bcrypt.\n"
  }.freeze

  def app
    ReviewChecks.fixture do |root, _commit|
      APP.each do |path, text|
        FileUtils.mkdir_p(File.join(root, File.dirname(path)))
        File.write(File.join(root, path), text)
      end
      DynamicReviews.git(root, 'add', '.')
      DynamicReviews.git(root, 'commit', '-q', '-m', 'test: a small app')
      yield root
    end
  end

  def run
    checks = {}
    checks['candidates are the sign-in, regulated data, secrets and payment files, and never what they matched'] = lambda do
      app do |root|
        found = DCR::Critical.new(root).candidates
        kinds = found.to_h { |file| [file['path'], file['kinds'].keys] }
        assert(kinds['app/api/auth/login/route.ts']&.include?('login'), 'The sign-in route was not a candidate')
        assert(kinds['app/api/stripe/webhook/route.ts']&.include?('payments'), 'The payment webhook was not a candidate')
        assert(kinds['app/profile/save.ts']&.include?('regulated'), 'The profile with a birth date was not a candidate')
        assert(kinds['lib/supabase.ts']&.include?('secrets'), 'The key shipped to the browser was not a candidate')
        left_out = ['components/Button.tsx', 'app/api/auth/login/route.test.ts', 'db/migrations/001_users.sql', 'README.md']
        assert((kinds.keys & left_out).empty?, "Listed files a critical review leaves out: #{kinds.keys & left_out}")
        assert(found.find { |file| file['path'] == 'lib/supabase.ts' }['kinds']['secrets'].include?('key written in the code'), 'The key in the code was not flagged')
        brief = DCR::Critical.brief(found, 'candidates.json')
        assert(!"#{brief}#{JSON.generate(found)}".include?('sk_live_Z9'), 'The candidates printed a key')
      end
    end
    checks['a repository review reads only its chosen files, whole, and refuses a scope that is not files in the checkout'] = lambda do
      app do |root|
        chosen = ['app/api/stripe/webhook/route.ts', {'path' => 'app/api/auth/login/route.ts', 'reason' => 'Checks the password'}]
        snapshot = DynamicReviews.collect(repo: root, mode: 'repo', paths: chosen)
        assert(snapshot['files'].map { |file| file['path'] } == ['app/api/auth/login/route.ts', 'app/api/stripe/webhook/route.ts'], 'Collected other files than the chosen ones')
        assert(snapshot['paths'] == snapshot['files'].map { |file| file['path'] }, 'The snapshot does not keep its scope')
        login = snapshot['files'].first
        assert(login['hunks'].length == 1 && login['hunks'].first['new_count'] == APP['app/api/auth/login/route.ts'].lines.length, 'A chosen file was not read whole')
        rejects('Accepted an empty scope') { DynamicReviews.collect(repo: root, mode: 'repo', paths: []) }
        rejects('Accepted a file not in the checkout') { DynamicReviews.collect(repo: root, mode: 'repo', paths: ['app/missing.ts']) }
        rejects('Accepted a path outside the checkout') { DynamicReviews.collect(repo: root, mode: 'repo', paths: ['../outside.ts']) }
        rejects('Accepted a scope of the whole app') { DynamicReviews.collect(repo: root, mode: 'repo', paths: Array.new(DynamicReviews::SCOPE_LIMIT + 1) { 'README.md' }) }
      end
    end
    checks['updates keep to the chosen files as the app changes around them'] = lambda do
      app do |root|
        snapshot = DynamicReviews.collect(repo: root, mode: 'repo', paths: ['app/api/stripe/webhook/route.ts'])
        file = snapshot['files'].first
        review = {'title' => 'Critical parts', 'summary' => 'The payment webhook.', 'effort' => {'score' => 2, 'reason' => 'One file'}, 'coverage' => 'The chosen file', 'validation' => ['Not run: fixture'],
                  'groups' => [{'title' => 'Payments', 'summary' => 'Marks orders paid.', 'layers' => [{'title' => 'Webhook', 'items' => [{'file' => file['id'], 'summaries' => {file['hunks'].first['id'] => 'Marks an order paid.'}}]}]}]}
        Dir.mktmpdir('critical-series-') do |out|
          File.write(File.join(out, 'snapshot.json'), JSON.generate(snapshot))
          File.write(File.join(out, 'review.json'), JSON.generate(review))
          ReviewSeries.start(repo: root, name: 'critical', snapshot: File.join(out, 'snapshot.json'), review: File.join(out, 'review.json'))
        end
        path = ReviewSeries.directory(root, 'critical')
        assert(ReviewSeries.manifest(path)['paths'] == ['app/api/stripe/webhook/route.ts'], 'The series does not keep its scope')
        File.write(File.join(root, 'components/Button.tsx'), "export const Button = () => null\n")
        File.write(File.join(root, 'components/Card.tsx'), "export const Card = () => null\n")
        assert(ReviewSeries.sync(repo: root, name: 'critical')['status'] == 'unchanged', 'A change outside the chosen files updated the review')
        File.write(File.join(root, 'app/api/stripe/webhook/route.ts'), "#{APP['app/api/stripe/webhook/route.ts']}// verify the signature\n")
        result = ReviewSeries.sync(repo: root, name: 'critical')
        assert(result['status'] == 'updated', 'A change to a chosen file did not update the review')
        files = ReviewSeries.latest(path)['snapshot']['files'].map { |entry| entry['path'] }
        assert(files == ['app/api/stripe/webhook/route.ts'], "The update brought in other files: #{files}")
      end
    end
    checks.each { |description, check| check.call; puts "PASS #{description}" }
    puts "#{checks.length} critical checks passed"
  end
end

CriticalChecks.run if $PROGRAM_NAME == __FILE__
