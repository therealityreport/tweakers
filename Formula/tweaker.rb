class Tweaker < Formula
  desc "Tweak system for the OpenAI Codex desktop app"
  homepage "https://github.com/therealityreport/tweakers"
  url "https://github.com/therealityreport/tweakers.git",
      tag: "vX.Y.Z" # TODO(maintainer): set to the real therealityreport/tweakers release tag
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args(prefix: false),
           "--workspaces", "--include-workspace-root", "--ignore-scripts"
    system "npm", "run", "build"

    libexec.install Dir["*"]
    chmod 0755, libexec/"packages/installer/dist/cli.js"
    ["tweaker", "tweakers", "codexplusplus", "codex-plusplus"].each do |cmd|
      (bin/cmd).write <<~EOS
        #!/bin/bash
        exec "#{Formula["node"].opt_bin}/node" "#{libexec}/packages/installer/dist/cli.js" "$@"
      EOS
      chmod 0755, bin/cmd
    end
  end

  def caveats
    <<~EOS
      Run `tweaker install` to patch Codex.app.
      Run `tweaker update` to update Tweaker from GitHub source.
    EOS
  end

  test do
    assert_match(/tweaker, \d+\.\d+\.\d+/, shell_output("#{bin}/tweakers --version"))
    assert_match(/tweaker, \d+\.\d+\.\d+/, shell_output("#{bin}/tweaker --version"))
    assert_match(/tweaker, \d+\.\d+\.\d+/, shell_output("#{bin}/codexplusplus --version"))
    assert_match(/tweaker, \d+\.\d+\.\d+/, shell_output("#{bin}/codex-plusplus --version"))
  end
end
