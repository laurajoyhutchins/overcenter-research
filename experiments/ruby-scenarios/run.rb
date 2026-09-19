require_relative "support/scenario"

Dir[File.join(__dir__, "*_scenario.rb")].sort.each do |path|
  require path
end
