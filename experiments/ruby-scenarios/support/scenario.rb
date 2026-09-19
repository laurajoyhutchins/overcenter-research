require "json"
require "open3"

module OvercenterRubyScenarios
  ROOT = File.expand_path("../../..", __dir__)
  DRIVER = File.join(ROOT, "experiments", "ruby-scenarios", "driver.ts")

  class ProviderScript
    def initialize(scenario, kind, id)
      @scenario = scenario
      @kind = kind
      @id = id
    end

    def write_accepted
      @scenario.__provider_effect(@id)
    end

    def worker_dies
      @scenario.__interrupt(@id)
    end

    def readback(state, as:)
      @scenario.__readback(@id, state, as)
    end

    def observe(event, as:)
      @scenario.__provider_observe(@kind, event, as)
    end

    def continuity(state, as:)
      @scenario.__provider_continuity(@kind, state, as)
    end
  end

  class Scenario
    def initialize(name)
      @name = name
      @operations = []
      @expectations = []
    end

    def semantic(upstream)
      {
        "kind" => "semantic",
        "upstream" => upstream.to_s,
        "consumes" => {
          "kind" => "output",
          "selector" => "verified-content"
        }
      }
    end

    def control(upstream)
      {
        "kind" => "control",
        "upstream" => upstream.to_s
      }
    end

    def obligation(id, content:, dependencies: [], packet: {}, consistency: :strong)
      @operations << {
        "op" => "define",
        "id" => id.to_s,
        "content" => content,
        "consistency" => consistency.to_s,
        "dependencies" => dependencies,
        "packet" => packet
      }
    end

    def amend(id, content:, dependencies: [], packet: {}, consistency: :strong)
      @operations << {
        "op" => "amend",
        "id" => id.to_s,
        "content" => content,
        "consistency" => consistency.to_s,
        "dependencies" => dependencies,
        "packet" => packet
      }
    end

    def provider(kind, id, expected: nil, packet: {}, &block)
      case kind
      when :eventually_consistent_file
        raise "expected is required" if expected.nil?
        obligation(
          id,
          content: expected,
          packet: packet,
          consistency: :eventual
        )
      when :github_status, :kubernetes_configmap
        # Provider semantics live in the TypeScript fixtures/adapters. Ruby
        # only names the hostile event sequence and its expected consequences.
      else
        raise "unsupported scenario provider: #{kind}"
      end

      ProviderScript.new(self, kind, id.to_s).instance_eval(&block)
    end

    def settle(id)
      @operations << {
        "op" => "settle",
        "id" => id.to_s
      }
    end

    def claim(id, as:)
      @operations << {
        "op" => "claim",
        "id" => id.to_s,
        "name" => as.to_s
      }
    end

    def renew_execution(permit, as:)
      @operations << {
        "op" => "renew-execution",
        "permit" => permit.to_s,
        "name" => as.to_s
      }
    end

    def reserve_effect(permit, as:)
      @operations << {
        "op" => "reserve-effect",
        "permit" => permit.to_s,
        "name" => as.to_s
      }
    end

    def checkpoint(name)
      @operations << {
        "op" => "checkpoint",
        "name" => name.to_s
      }
    end

    def reconstruct(name)
      @operations << {
        "op" => "reconstruct",
        "name" => name.to_s
      }
    end

    def __provider_observe(kind, event, name)
      provider = {
        github_status: "github-status",
        kubernetes_configmap: "kubernetes-configmap"
      }.fetch(kind)

      @operations << {
        "op" => "provider-observe",
        "provider" => provider,
        "event" => event.to_s.tr("_", "-"),
        "name" => name.to_s
      }
    end

    def __provider_continuity(kind, state, name)
      provider = {
        github_status: "github-status",
        kubernetes_configmap: "kubernetes-configmap"
      }.fetch(kind)

      @operations << {
        "op" => "provider-continuity",
        "provider" => provider,
        "continuity" => state.to_s,
        "name" => name.to_s
      }
    end

    def __provider_effect(id)
      @operations << {
        "op" => "provider-effect",
        "id" => id.to_s
      }
    end

    def __interrupt(id)
      @operations << {
        "op" => "interrupt",
        "id" => id.to_s
      }
    end

    def __readback(id, state, name)
      operation = {
        "op" => "readback",
        "id" => id.to_s,
        "name" => name.to_s
      }

      case state
      when :missing, :expected
        operation["state"] = state.to_s
      else
        operation["state"] = "value"
        operation["value"] = state.to_s
      end
      @operations << operation
    end

    def expect_status(checkpoint, id, status)
      @expectations << lambda do |result|
        work = work_at(result, checkpoint, id)
        actual = work.fetch("status")
        next if actual == status

        raise "expected #{id} at #{checkpoint} to be #{status}, got #{actual}"
      end
    end

    def expect_same_run(id, before:, after:)
      @expectations << lambda do |result|
        earlier = work_at(result, before, id).fetch("run_id")
        later = work_at(result, after, id).fetch("run_id")
        next if earlier && earlier == later

        raise "expected #{id} to reuse run #{earlier.inspect}, got #{later.inspect}"
      end
    end

    def expect_no_run(checkpoint, id)
      @expectations << lambda do |result|
        run = work_at(result, checkpoint, id)["run_id"]
        next if run.nil?

        raise "expected #{id} at #{checkpoint} to have no reusable run, got #{run}"
      end
    end

    def expect_same_projection(left:, right:)
      @expectations << lambda do |result|
        earlier = checkpoint_at(result, left)
        later = checkpoint_at(result, right)
        next if earlier == later

        raise "expected #{left} and #{right} projections to be byte-equivalent JSON values"
      end
    end

    def expect_readback(name, disposition:, certainty:, error: nil, absence_evidence: :any)
      @expectations << lambda do |result|
        receipt = result.fetch("readbacks").fetch(name.to_s)
        observed = receipt.fetch("observed")

        unless receipt.fetch("disposition") == disposition
          raise "expected #{name} disposition #{disposition}, got #{receipt.fetch("disposition")}"
        end
        unless observed.fetch("mutation_certainty") == certainty
          raise "expected #{name} certainty #{certainty}, got #{observed.fetch("mutation_certainty")}"
        end
        unless observed["observation_error"] == error
          raise "expected #{name} error #{error.inspect}, got #{observed["observation_error"].inspect}"
        end
        unless absence_evidence == :any || observed["absence_evidence"] == absence_evidence
          raise "expected #{name} absence evidence #{absence_evidence.inspect}, got #{observed["absence_evidence"].inspect}"
        end
      end
    end

    def expect_absence_kind(name, kind)
      @expectations << lambda do |result|
        receipt = result.fetch("readbacks").fetch(name.to_s)
        observed = receipt.fetch("observed")
        evidence = observed["absence_evidence"]
        actual = evidence && evidence["kind"]
        next if actual == kind

        raise "expected #{name} absence kind #{kind.inspect}, got #{actual.inspect}"
      end
    end

    def expect_evidence_preserved(name, expected)
      @expectations << lambda do |result|
        outcome = result.fetch("outcomes").fetch(name.to_s)
        actual = outcome.fetch("evidence_preserved")
        next if actual == expected

        raise "expected #{name} evidence_preserved=#{expected}, got #{actual}"
      end
    end

    def expect_error(name, error)
      @expectations << lambda do |result|
        outcome = result.fetch("outcomes").fetch(name.to_s)
        unless outcome["ok"] == false && outcome["error"] == error
          raise "expected #{name} to fail with #{error.inspect}, got #{outcome.inspect}"
        end
      end
    end

    def expect_success(name)
      @expectations << lambda do |result|
        outcome = result.fetch("outcomes").fetch(name.to_s)
        next if outcome["ok"] == true

        raise "expected #{name} to succeed, got #{outcome.inspect}"
      end
    end

    def expect_effect_attempts(id, count)
      @expectations << lambda do |result|
        actual = result.fetch("effect_attempts").fetch(id.to_s, 0)
        next if actual == count

        raise "expected #{id} effect attempts #{count}, got #{actual}"
      end
    end

    def expect_receipts(id, *dispositions)
      @expectations << lambda do |result|
        actual = result.fetch("receipts").fetch(id.to_s)
        next if actual == dispositions

        raise "expected #{id} receipts #{dispositions.inspect}, got #{actual.inspect}"
      end
    end

    def run
      payload = JSON.generate({
        "scenario" => @name,
        "operations" => @operations
      })
      stdout, stderr, status = Open3.capture3(
        "node",
        "--experimental-strip-types",
        DRIVER,
        stdin_data: payload,
        chdir: ROOT
      )
      unless status.success?
        raise "#{@name}: TypeScript probe failed\n#{stderr}"
      end

      result = JSON.parse(stdout)
      @expectations.each { |expectation| expectation.call(result) }
      puts "PASS #{@name}"
    end

    private

    def checkpoint_at(result, checkpoint)
      result.fetch("checkpoints").fetch(checkpoint.to_s)
    end

    def work_at(result, checkpoint, id)
      checkpoint_at(result, checkpoint).find { |work| work.fetch("id") == id.to_s } ||
        raise("missing #{id} at #{checkpoint}")
    end
  end

  def self.scenario(name, &block)
    scenario = Scenario.new(name)
    scenario.instance_eval(&block)
    scenario.run
  end
end

def scenario(name, &block)
  OvercenterRubyScenarios.scenario(name, &block)
end
