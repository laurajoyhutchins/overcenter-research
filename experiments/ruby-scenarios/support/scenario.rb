require "json"
require "open3"

module OvercenterRubyScenarios
  ROOT = File.expand_path("../../..", __dir__)
  DRIVER = File.join(ROOT, "experiments", "ruby-scenarios", "driver.ts")

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

    def obligation(id, content:, dependencies: [], packet: {})
      @operations << {
        "op" => "define",
        "id" => id.to_s,
        "content" => content,
        "dependencies" => dependencies,
        "packet" => packet
      }
    end

    def amend(id, content:, dependencies: [], packet: {})
      @operations << {
        "op" => "amend",
        "id" => id.to_s,
        "content" => content,
        "dependencies" => dependencies,
        "packet" => packet
      }
    end

    def settle(id)
      @operations << {
        "op" => "settle",
        "id" => id.to_s
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
