require "json"
require "open3"

module OvercenterRubyScenarios
  ROOT = File.expand_path("../../..", __dir__)
  DRIVER = File.join(ROOT, "experiments", "ruby-scenarios", "driver.ts")
  PROVIDERS = {
    github_status: "github-status",
    kubernetes_configmap: "kubernetes-configmap"
  }.freeze

  class ProviderScript
    def initialize(scenario, kind, id)
      @scenario, @kind, @id = scenario, kind, id
    end

    def write_accepted = @scenario.__op("provider-effect", id: @id)
    def worker_dies = @scenario.__op("interrupt", id: @id)
    def readback(state, as:) = @scenario.__readback(@id, state, as)
    def observe(event, as:) = @scenario.__provider_observe(@kind, event, as)
    def continuity(state, as:) = @scenario.__provider_continuity(@kind, state, as)
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
        "consumes" => {"kind" => "output", "selector" => "verified-content"}
      }
    end

    def control(upstream)
      {"kind" => "control", "upstream" => upstream.to_s}
    end

    def obligation(id, content:, dependencies: [], packet: {}, consistency: :strong)
      definition("define", id, content, dependencies, packet, consistency)
    end

    def amend(id, content:, dependencies: [], packet: {}, consistency: :strong)
      definition("amend", id, content, dependencies, packet, consistency)
    end

    def provider(kind, id, expected: nil, packet: {}, &block)
      if kind == :eventually_consistent_file
        raise "expected is required" if expected.nil?
        obligation(id, content: expected, packet: packet, consistency: :eventual)
      elsif !PROVIDERS.key?(kind)
        raise "unsupported scenario provider: #{kind}"
      end
      ProviderScript.new(self, kind, id.to_s).instance_eval(&block)
    end

    def settle(id) = __op("settle", id: id)
    def claim(id, as:) = __op("claim", id: id, name: as)
    def renew_execution(permit, as:) = __op("renew-execution", permit: permit, name: as)
    def reserve_effect(permit, as:) = __op("reserve-effect", permit: permit, name: as)
    def checkpoint(name) = __op("checkpoint", name: name)
    def reconstruct(name) = __op("reconstruct", name: name)

    def __op(op, **fields)
      @operations << {"op" => op}.merge(stringify(fields))
    end

    def __provider_observe(kind, event, name)
      __op(
        "provider-observe",
        provider: PROVIDERS.fetch(kind),
        event: event.to_s.tr("_", "-"),
        name: name
      )
    end

    def __provider_continuity(kind, state, name)
      __op(
        "provider-continuity",
        provider: PROVIDERS.fetch(kind),
        continuity: state,
        name: name
      )
    end

    def __readback(id, state, name)
      if [:missing, :expected].include?(state)
        __op("readback", id: id, name: name, state: state)
      else
        __op("readback", id: id, name: name, state: :value, value: state)
      end
    end

    def expect_status(checkpoint, id, status)
      expect do |result|
        actual = work_at(result, checkpoint, id).fetch("status")
        fail_expectation("#{id} at #{checkpoint}", status, actual) unless actual == status
      end
    end

    def expect_same_run(id, before:, after:)
      expect do |result|
        earlier = work_at(result, before, id)["run_id"]
        later = work_at(result, after, id)["run_id"]
        unless earlier && earlier == later
          raise "expected #{id} to reuse run #{earlier.inspect}, got #{later.inspect}"
        end
      end
    end

    def expect_no_run(checkpoint, id)
      expect do |result|
        actual = work_at(result, checkpoint, id)["run_id"]
        raise "expected #{id} at #{checkpoint} to have no reusable run, got #{actual}" if actual
      end
    end

    def expect_same_projection(left:, right:)
      expect do |result|
        a = checkpoint_at(result, left)
        b = checkpoint_at(result, right)
        raise "expected #{left} and #{right} projections to match" unless a == b
      end
    end

    def expect_readback(name, disposition:, certainty:, error: nil, absence_evidence: :any)
      expect do |result|
        receipt = result.fetch("readbacks").fetch(name.to_s)
        observed = receipt.fetch("observed")
        fail_expectation("#{name} disposition", disposition, receipt["disposition"]) unless receipt["disposition"] == disposition
        fail_expectation("#{name} certainty", certainty, observed["mutation_certainty"]) unless observed["mutation_certainty"] == certainty
        fail_expectation("#{name} error", error, observed["observation_error"]) unless observed["observation_error"] == error
        if absence_evidence != :any && observed["absence_evidence"] != absence_evidence
          fail_expectation("#{name} absence evidence", absence_evidence, observed["absence_evidence"])
        end
      end
    end

    def expect_absence_kind(name, kind)
      expect do |result|
        actual = result.dig("readbacks", name.to_s, "observed", "absence_evidence", "kind")
        fail_expectation("#{name} absence kind", kind, actual) unless actual == kind
      end
    end

    def expect_evidence_preserved(name, expected)
      expect do |result|
        actual = result.dig("outcomes", name.to_s, "evidence_preserved")
        fail_expectation("#{name} evidence_preserved", expected, actual) unless actual == expected
      end
    end

    def expect_error(name, error)
      expect do |result|
        actual = result.dig("outcomes", name.to_s)
        unless actual == {"ok" => false, "error" => error}
          fail_expectation(name, {"ok" => false, "error" => error}, actual)
        end
      end
    end

    def expect_success(name)
      expect do |result|
        actual = result.dig("outcomes", name.to_s, "ok")
        fail_expectation(name, true, actual) unless actual == true
      end
    end

    def expect_effect_attempts(id, count)
      expect do |result|
        actual = result.fetch("effect_attempts").fetch(id.to_s, 0)
        fail_expectation("#{id} effect attempts", count, actual) unless actual == count
      end
    end

    def expect_receipts(id, *dispositions)
      expect do |result|
        actual = result.fetch("receipts").fetch(id.to_s)
        fail_expectation("#{id} receipts", dispositions, actual) unless actual == dispositions
      end
    end

    def run
      payload = JSON.generate("scenario" => @name, "operations" => @operations)
      stdout, stderr, status = Open3.capture3(
        "node", "--experimental-strip-types", DRIVER,
        stdin_data: payload, chdir: ROOT
      )
      raise "#{@name}: TypeScript probe failed\n#{stderr}" unless status.success?

      result = JSON.parse(stdout)
      @expectations.each { |expectation| expectation.call(result) }
      puts "PASS #{@name}"
    end

    private

    def definition(op, id, content, dependencies, packet, consistency)
      __op(
        op,
        id: id,
        content: content,
        consistency: consistency,
        dependencies: dependencies,
        packet: packet
      )
    end

    def expect(&block) = @expectations << block

    def stringify(value)
      value.transform_keys(&:to_s).transform_values do |item|
        item.is_a?(Symbol) ? item.to_s : item
      end
    end

    def checkpoint_at(result, checkpoint)
      result.fetch("checkpoints").fetch(checkpoint.to_s)
    end

    def work_at(result, checkpoint, id)
      checkpoint_at(result, checkpoint).find { |work| work["id"] == id.to_s } ||
        raise("missing #{id} at #{checkpoint}")
    end

    def fail_expectation(subject, expected, actual)
      raise "expected #{subject} #{expected.inspect}, got #{actual.inspect}"
    end
  end

  def self.scenario(name, &block)
    Scenario.new(name).tap { |scenario| scenario.instance_eval(&block) }.run
  end
end

def scenario(name, &block)
  OvercenterRubyScenarios.scenario(name, &block)
end
