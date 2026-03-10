import Foundation

/// NanoClaw Orchestrator Runner
/// Compiled Swift binary for macOS launchd (no bash scripts per policy).
/// Loads .env, sets environment, and exec's node orchestrator-cli.

let home = ProcessInfo.processInfo.environment["HOME"] ?? "/Users/terryli"
let nanoclaw = "\(home)/fork-tools/nanoclaw"
let envFile = "\(nanoclaw)/.env"
let nodeEntry = "\(nanoclaw)/dist/orchestrator-cli.js"
let repoPath = nanoclaw  // Self-evolution: NanoClaw monitors its own repo
let logDir = "\(home)/.local/state/launchd-logs/nanoclaw"

// Ensure log directory exists
let fm = FileManager.default
try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)

// Load .env file
if let envContents = try? String(contentsOfFile: envFile, encoding: .utf8) {
    for line in envContents.split(separator: "\n") {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
        if let eqIdx = trimmed.firstIndex(of: "=") {
            let key = String(trimmed[trimmed.startIndex..<eqIdx])
            let val = String(trimmed[trimmed.index(after: eqIdx)...])
            setenv(key, val, 1)
        }
    }
}

// Find actual node binary (skip mise shims — they may not preserve fd inheritance under launchd)
let nodePaths = [
    "\(home)/.local/share/mise/installs/node/22.21.1/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
]
guard let nodeBin = nodePaths.first(where: { fm.fileExists(atPath: $0) }) else {
    fputs("ERROR: node not found in any expected path\n", stderr)
    exit(1)
}

// exec replaces this process — launchd manages the lifecycle
let args = [nodeBin, nodeEntry, "--repo", repoPath]
let cArgs = args.map { strdup($0) } + [nil]
execv(nodeBin, cArgs)

// Only reached if exec fails
perror("execv failed")
exit(1)
