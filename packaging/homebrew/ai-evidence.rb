# Homebrew formula. Lives in a tap:
#   brew tap dominionlabsinc/tap
#   brew install ai-evidence
class AiEvidence < Formula
  desc "Publish and verify an /ai.json evidence manifest for a website"
  homepage "https://github.com/DominionLabsInc/ai-evidence-manifest"
  url "https://github.com/DominionLabsInc/ai-evidence-manifest/archive/refs/tags/v0.3.0.tar.gz"
  sha256 "REPLACE_ON_RELEASE"
  license "Apache-2.0"
  head "https://github.com/DominionLabsInc/ai-evidence-manifest.git", branch: "main"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args(prefix: false), "--omit=dev"
    libexec.install Dir["*"]
    (bin/"ai-evidence").write_env_script libexec/"validator/cli.js", {}
    chmod 0755, libexec/"validator/cli.js"
    doc.install "SPEC.md", "NOTICE"
  end

  test do
    (testpath/"ai.json").write <<~JSON
      {
        "manifest": { "version": "1.0.0", "site": "https://example.com" },
        "claims": [{
          "id": "capability-test", "type": "capability", "claim": "A test claim.",
          "evidence": [{ "url": "https://example.com/x", "text": "A test claim.",
                         "source_type": "first-party" }]
        }]
      }
    JSON
    assert_match "VALID", shell_output("#{bin}/ai-evidence validate #{testpath}/ai.json --offline")
  end
end
