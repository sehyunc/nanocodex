import Foundation

/// The mobile catalog mirrors server-supported efforts; the server remains authoritative.
public struct ModelChoice: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let efforts: [String]
    public static let all: [Self] = [
        .init(id: "gpt-6-astra", name: "Astra", efforts: ["low", "medium", "high", "xhigh", "max"]),
        .init(id: "gpt-6-sol", name: "Sol", efforts: ["none", "low", "medium", "high", "xhigh", "max"]),
        .init(id: "gpt-6-luna", name: "Luna", efforts: ["none", "low", "medium", "high", "xhigh", "max"]),
        .init(id: "claude-fable-5-1", name: "Claude Fable 5.1", efforts: ["low", "medium", "high"]),
        .init(id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high"]),
        .init(id: "kimi-k3", name: "Kimi K3", efforts: ["low", "high"]),
        .init(id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", efforts: ["low", "medium", "high"]),
        .init(id: "@cf/zai-org/glm-5.3", name: "GLM 5.3", efforts: ["low", "medium", "high"]),
    ]
    public static func find(_ id: String) -> Self? {
        if id == "claude-sonnet-5" {
            return .init(id: id, name: "Claude Sonnet 5", efforts: ["low", "medium", "high"])
        }
        return all.first { $0.id == id }
    }
    public static func effortName(_ value: String) -> String {
        value == "xhigh" ? "Extra high" : value == "max" ? "Maximum" : value.capitalized
    }
}
